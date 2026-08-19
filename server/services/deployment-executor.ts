import crypto from "node:crypto";
import { DeploymentOperationPhase, OperationState, Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { nodeAgentClient } from "@/server/services/node-agent/client";
import { logAuditEvent } from "@/server/audit";
import { decryptSecret } from "@/server/security/crypto";
import type { AuthSession } from "@/server/auth/session";
import { getManagedExecutionEligibility } from "@/server/services/node-agent/execution-eligibility";
import { recomputePlanHash, resolveLatestSecretVersions, deriveImageRefs } from "@/server/services/deployment-plan";
import { reanalyzeRevision } from "@/server/services/deployments";

/**
 * Managed deployment executor (Phase 6B.4/5).
 *
 * Mutates Docker ONLY through the curated agent execution API, and only for
 * workloads with an explicit Deployment relation AND secure transport. The flow:
 *
 *   VALIDATE / PLAN / CONFIRM (synchronous, non-mutating)
 *   POST deploy(planHash)
 *     → eligibility + lock + stale-plan + security + secret resolution
 *     → DeploymentOperation (REQUESTED)
 *     → PREPARING → PULLING → APPLYING → VERIFYING → RECONCILING
 *     → SUCCEEDED | FAILED | CANCELLED   (+ DeploymentRelease on convergence)
 */

export type FrozenSecret = {
  key: string;
  secretId: string;
  versionId: string;
  versionNumber: number;
};

export type RequestDeploymentResult =
  | { status: "created"; operationId: string }
  | { status: "deployment_not_found" }
  | { status: "revision_not_found" }
  | { status: "execution_unsupported"; reason: string }
  | { status: "deployment_op_in_progress" }
  | { status: "container_op_in_progress" }
  | { status: "plan_stale" }
  | { status: "security_blocked"; ruleIds: string[] }
  | { status: "security_ack_required"; ruleIds: string[] }
  | { status: "missing_secret"; keys: string[] };

const ACTIVE_STATES: OperationState[] = ["REQUESTED", "QUEUED", "RUNNING"];

async function loadDeploymentContext(deploymentId: string) {
  const deployment = await prisma.deployment.findUnique({
    where: { id: deploymentId },
    include: { project: { include: { node: true } } }
  });
  if (!deployment) return null;
  return deployment;
}

async function hasActiveContainerOp(projectId: string): Promise<boolean> {
  const containers = await prisma.container.findMany({
    where: { projectId, isActive: true },
    select: { id: true }
  });
  if (containers.length === 0) return false;
  const active = await prisma.operation.findFirst({
    where: { state: { in: ACTIVE_STATES }, containerId: { in: containers.map((c) => c.id) } },
    select: { id: true }
  });
  return active !== null;
}

export async function requestDeploymentOperation(input: {
  deploymentId: string;
  type: "DEPLOY" | "ROLLBACK";
  revisionId: string;
  planHash: string;
  actor: AuthSession;
  sourceIp?: string | null;
}): Promise<RequestDeploymentResult> {
  const deployment = await loadDeploymentContext(input.deploymentId);
  if (!deployment) return { status: "deployment_not_found" };

  const revision = await prisma.deploymentRevision.findFirst({
    where: { id: input.revisionId, deploymentId: deployment.id }
  });
  if (!revision) return { status: "revision_not_found" };

  const node = deployment.project.node;
  // Single authoritative eligibility gate (TLS/CA/cert/compose/feature flag).
  // The actual request still performs full TLS verification independently.
  const eligibility = await getManagedExecutionEligibility(node);
  if (!eligibility.allowed) {
    return { status: "execution_unsupported", reason: eligibility.message ?? eligibility.reasons.join(", ") };
  }

  // Deployment-level lock: at most one active deployment operation.
  const activeDeploymentOp = await prisma.deploymentOperation.findFirst({
    where: { deploymentId: deployment.id, state: { in: ACTIVE_STATES } },
    select: { id: true }
  });
  if (activeDeploymentOp) return { status: "deployment_op_in_progress" };

  // Container/workload operation conflict: block deploy while a member
  // container has an in-flight start/stop/restart.
  if (await hasActiveContainerOp(deployment.projectId)) {
    return { status: "container_op_in_progress" };
  }

  // Stale-plan protection: recompute the plan hash from current state.
  const currentHash = await recomputePlanHash(deployment.id, revision.id);
  if (currentHash === null || currentHash !== input.planHash) {
    return { status: "plan_stale" };
  }

  // Security re-analysis immediately before mutation.
  const reanalysis = await reanalyzeRevision(revision.id);
  if (!reanalysis) return { status: "revision_not_found" };
  const blocked = reanalysis.findings.filter((f) => f.severity === "BLOCKED");
  if (blocked.length > 0) {
    return { status: "security_blocked", ruleIds: blocked.map((f) => f.ruleId) };
  }
  if (reanalysis.uncoveredHighRisk.length > 0) {
    return { status: "security_ack_required", ruleIds: reanalysis.uncoveredHighRisk.map((f) => f.ruleId) };
  }

  // Resolve + freeze secret versions once, now.
  const latestSecrets = await resolveLatestSecretVersions(deployment.id, revision.secretReferences);
  const frozenSecrets: FrozenSecret[] = [];
  const missing: string[] = [];
  for (const key of revision.secretReferences) {
    const s = latestSecrets.get(key);
    if (!s || !s.versionId || s.versionNumber === null) {
      missing.push(key);
      continue;
    }
    frozenSecrets.push({ key, secretId: s.secretId, versionId: s.versionId, versionNumber: s.versionNumber });
  }
  if (missing.length > 0) return { status: "missing_secret", keys: missing };

  const operationId = await prisma.deploymentOperation
    .create({
      data: {
        type: input.type,
        state: "REQUESTED",
        phase: DeploymentOperationPhase.PREPARING,
        requestId: crypto.randomUUID(),
        deploymentId: deployment.id,
        revisionId: revision.id,
        actorUserId: input.actor.userId,
        actorEmail: input.actor.email,
        actorRole: input.actor.role,
        result: {
          planHash: input.planHash,
          frozenSecrets,
          runtimeChanged: false,
          cancelled: false
        }
      },
      select: { id: true }
    })
    .then((o) => o.id)
    .catch((error) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return null;
      }
      throw error;
    });

  if (!operationId) return { status: "deployment_op_in_progress" };

  await logAuditEvent({
    actorUserId: input.actor.userId,
    actorEmail: input.actor.email,
    actorRole: input.actor.role,
    action: `${input.type}_REQUESTED`,
    targetType: "DEPLOYMENT_OPERATION",
    targetId: operationId,
    metadata: { deploymentId: deployment.id, revisionNumber: revision.revisionNumber, planHash: input.planHash },
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null
  });

  void executeDeploymentOperation(operationId);
  return { status: "created", operationId };
}

async function setPhase(operationId: string, phase: DeploymentOperationPhase): Promise<void> {
  await prisma.deploymentOperation.update({ where: { id: operationId }, data: { phase } });
}

async function patchResult(operationId: string, patch: Record<string, unknown>): Promise<void> {
  const op = await prisma.deploymentOperation.findUnique({ where: { id: operationId } });
  if (!op) return;
  const current = (op.result as Record<string, unknown>) ?? {};
  await prisma.deploymentOperation.update({
    where: { id: operationId },
    data: { result: { ...current, ...patch } as unknown as Prisma.InputJsonValue }
  });
}

async function finish(operationId: string, state: OperationState, error: string | null, patch: Record<string, unknown> = {}): Promise<void> {
  await prisma.deploymentOperation.update({
    where: { id: operationId },
    data: { state, error, finishedAt: new Date(), result: await mergeResult(operationId, patch) }
  });
}

async function mergeResult(operationId: string, patch: Record<string, unknown>): Promise<Prisma.InputJsonValue> {
  const op = await prisma.deploymentOperation.findUnique({ where: { id: operationId } });
  const current = (op?.result as Record<string, unknown>) ?? {};
  return { ...current, ...patch } as unknown as Prisma.InputJsonValue;
}

async function isCancelled(operationId: string): Promise<boolean> {
  const op = await prisma.deploymentOperation.findUnique({
    where: { id: operationId },
    select: { state: true }
  });
  return op?.state === "CANCELLED";
}

async function decryptFrozenSecrets(frozenSecrets: FrozenSecret[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const fs of frozenSecrets) {
    const version = await prisma.secretVersion.findUnique({ where: { id: fs.versionId } });
    if (!version) continue;
    try {
      out[fs.key] = decryptSecret(version.ciphertext, "DEPLOYMENT_SECRETS");
    } catch {
      // Missing/failed key → skip; verification/apply will surface as error.
    }
  }
  return out;
}

export async function executeDeploymentOperation(operationId: string): Promise<void> {
  const operation = await prisma.deploymentOperation.findUnique({
    where: { id: operationId },
    include: { deployment: { include: { project: { include: { node: true } } } } }
  });
  if (!operation) return;
  if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(operation.state)) return;

  const deployment = operation.deployment;
  const node = deployment.project.node;
  const revision = operation.revisionId
    ? await prisma.deploymentRevision.findUnique({ where: { id: operation.revisionId } })
    : null;
  if (!revision) {
    await finish(operationId, "FAILED", "Revision not found");
    return;
  }

  await prisma.deploymentOperation.update({ where: { id: operationId }, data: { state: "QUEUED", queuedAt: new Date() } });
  await prisma.deploymentOperation.update({ where: { id: operationId }, data: { state: "RUNNING", startedAt: new Date(), phase: DeploymentOperationPhase.PREPARING } });

  const frozenSecrets = ((operation.result as Record<string, unknown>)?.frozenSecrets ?? []) as FrozenSecret[];
  const nonSecretEnv = (revision.environmentSnapshot as Record<string, string>) ?? {};

  // ---- PREPARING -----------------------------------------------------------
  await setPhase(operationId, DeploymentOperationPhase.PREPARING);
  const prepared = await nodeAgentClient.prepareDeployment(node, {
    deploymentId: deployment.id,
    operationId,
    revisionNumber: revision.revisionNumber,
    compose: revision.composeCanonical,
    env: nonSecretEnv,
    composeProjectName: deployment.composeProjectName
  });
  if (!prepared.ok) {
    await finish(operationId, "FAILED", prepared.error ?? "prepare failed", { phase: "PREPARING" });
    return;
  }
  if (await isCancelled(operationId)) return;

  // ---- PULLING -------------------------------------------------------------
  await setPhase(operationId, DeploymentOperationPhase.PULLING);
  const pull = await nodeAgentClient.pullDeployment(node, {
    deploymentId: deployment.id,
    operationId,
    revisionNumber: revision.revisionNumber
  });
  if (!pull.ok) {
    await finish(operationId, "FAILED", pull.error ?? "pull failed", { phase: "PULLING" });
    return;
  }
  if (await isCancelled(operationId)) return;
  await patchResult(operationId, { images: pull.images });

  // ---- APPLYING ------------------------------------------------------------
  await setPhase(operationId, DeploymentOperationPhase.APPLYING);
  const secrets = await decryptFrozenSecrets(frozenSecrets);
  let applyError: string | null = null;
  const applied = await nodeAgentClient.applyDeployment(node, {
    deploymentId: deployment.id,
    operationId,
    revisionNumber: revision.revisionNumber,
    secrets
  });
  if (!applied.ok) {
    applyError = applied.error ?? "apply failed";
    await patchResult(operationId, { applyError });
  }

  // ---- VERIFYING -----------------------------------------------------------
  // `docker compose up -d` can return before containers are visible to
  // `docker compose ps` (and healthchecks need time to stabilize). Poll within
  // the deployment's verify-grace window until the runtime is conclusively
  // converged (HEALTHY or DEGRADED) rather than declaring a false DRIFTED.
  await setPhase(operationId, DeploymentOperationPhase.VERIFYING);
  const graceMs = deployment.verifyGraceMs ?? 30_000;
  const verifyDeadline = Date.now() + graceMs;
  let verify = await nodeAgentClient.verifyDeployment(node, {
    deploymentId: deployment.id,
    operationId,
    revisionNumber: revision.revisionNumber
  });
  while (
    verify &&
    verify.verdict !== "CONVERGED_HEALTHY" &&
    verify.verdict !== "CONVERGED_DEGRADED" &&
    Date.now() < verifyDeadline &&
    !(await isCancelled(operationId))
  ) {
    await new Promise((r) => setTimeout(r, 1000));
    verify = await nodeAgentClient.verifyDeployment(node, {
      deploymentId: deployment.id,
      operationId,
      revisionNumber: revision.revisionNumber
    });
  }

  // ---- RECONCILING ---------------------------------------------------------
  await setPhase(operationId, DeploymentOperationPhase.RECONCILING);
  await patchResult(operationId, { verify });

  if (verify && (verify.verdict === "CONVERGED_HEALTHY" || verify.verdict === "CONVERGED_DEGRADED")) {
    const healthy = verify.verdict === "CONVERGED_HEALTHY";
    const releaseId = await createRelease({
      deploymentId: deployment.id,
      revisionId: revision.id,
      operationId,
      healthVerdict: healthy ? "HEALTHY" : "DEGRADED",
      composeVersion: node.composeVersion ?? null,
      images: buildReleaseImages(revision.composeCanonical, verify.services),
      secrets: frozenSecrets.map((f) => ({ secretId: f.secretId, secretVersionId: f.versionId, key: f.key, versionNumber: f.versionNumber }))
    });

    if (healthy) {
      await prisma.deployment.update({
        where: { id: deployment.id },
        data: { currentReleaseId: releaseId, lastHealthyReleaseId: releaseId, runtimeState: "CONVERGED" }
      });
      await finish(operationId, "SUCCEEDED", null, { runtimeConverged: true, health: "HEALTHY", releaseId });
      await logAuditEvent({
        actorUserId: operation.actorUserId, actorEmail: operation.actorEmail, actorRole: operation.actorRole,
        action: `${operation.type}_SUCCEEDED`, targetType: "DEPLOYMENT_OPERATION", targetId: operationId,
        metadata: { deploymentId: deployment.id, revisionNumber: revision.revisionNumber, releaseId }, result: "SUCCESS"
      });
    } else {
      // Degraded: runtime converged to candidate, but health failed.
      const previousHealthy = deployment.lastHealthyReleaseId;
      await prisma.deployment.update({
        where: { id: deployment.id },
        data: { currentReleaseId: releaseId, runtimeState: "DEGRADED" }
      });
      await finish(operationId, "FAILED", "health verification failed", {
        runtimeConverged: true, health: "DEGRADED", releaseId, previousHealthyReleaseId: previousHealthy
      });
      await logAuditEvent({
        actorUserId: operation.actorUserId, actorEmail: operation.actorEmail, actorRole: operation.actorRole,
        action: `${operation.type}_FAILED`, targetType: "DEPLOYMENT_OPERATION", targetId: operationId,
        metadata: { deploymentId: deployment.id, revisionNumber: revision.revisionNumber, releaseId, degraded: true }, result: "FAILURE"
      });
    }
    return;
  }

  // Not conclusively converged (DRIFTED / FAILED / missing verify).
  await prisma.deployment.update({
    where: { id: deployment.id },
    data: { currentReleaseId: null, runtimeState: "DRIFTED" }
  });
  const error = applyError ?? (verify ? `verification ${verify.verdict}` : "verification unavailable");
  await finish(operationId, "FAILED", error, { runtimeConverged: false, runtimeState: "DRIFTED" });
  await logAuditEvent({
    actorUserId: operation.actorUserId, actorEmail: operation.actorEmail, actorRole: operation.actorRole,
    action: `${operation.type}_FAILED`, targetType: "DEPLOYMENT_OPERATION", targetId: operationId,
    metadata: { deploymentId: deployment.id, revisionNumber: revision.revisionNumber, error }, result: "FAILURE"
  });
  await logAuditEvent({
    actorUserId: operation.actorUserId, actorEmail: operation.actorEmail, actorRole: operation.actorRole,
    action: "DEPLOYMENT_RUNTIME_DRIFT_DETECTED", targetType: "DEPLOYMENT", targetId: deployment.id,
    metadata: { revisionNumber: revision.revisionNumber }, result: "FAILURE"
  });
}

/**
 * Merge desired image refs (from the revision) with ACTUAL runtime image
 * identity reported by verification (container inspect .Image + repo digest).
 * Runtime values win: a mutable tag can resolve differently per deploy.
 */
function buildReleaseImages(
  composeCanonical: string,
  verifyServices: Array<{ name: string; imageId?: string | null; repoDigest?: string | null; imageRef?: string | null }> | undefined
): { serviceName: string; imageRef: string; imageId: string | null; repoDigest: string | null }[] {
  const desired = deriveImageRefs(composeCanonical);
  const runtime = new Map((verifyServices ?? []).map((s) => [s.name, s]));
  return desired.map((d) => {
    const r = runtime.get(d.serviceName);
    return {
      serviceName: d.serviceName,
      imageRef: d.imageRef,
      imageId: r?.imageId ?? null,
      repoDigest: r?.repoDigest ?? null
    };
  });
}

async function createRelease(input: {
  deploymentId: string;
  revisionId: string;
  operationId: string;
  healthVerdict: "HEALTHY" | "DEGRADED";
  composeVersion: string | null;
  images: { serviceName: string; imageRef: string; imageId: string | null; repoDigest: string | null }[];
  secrets: { secretId: string; secretVersionId: string; key: string; versionNumber: number }[];
}): Promise<string> {
  const release = await prisma.deploymentRelease.create({
    data: {
      deploymentId: input.deploymentId,
      revisionId: input.revisionId,
      operationId: input.operationId,
      healthVerdict: input.healthVerdict,
      composeVersion: input.composeVersion,
      appliedAt: new Date(),
      verifiedAt: new Date(),
      images: {
        create: input.images.map((i) => ({
          serviceName: i.serviceName,
          imageRef: i.imageRef,
          imageId: i.imageId,
          repoDigest: i.repoDigest
        }))
      },
      secrets: {
        create: input.secrets.map((s) => ({
          secretId: s.secretId, secretVersionId: s.secretVersionId, key: s.key, versionNumber: s.versionNumber
        }))
      }
    },
    select: { id: true }
  });
  return release.id;
}

/**
 * Cancellation: stop future stages, best-effort abort, then VERIFY + RECONCILE
 * to record actual runtime. A cancelled operation may have changed Docker.
 */
export async function requestCancellation(operationId: string, actor: AuthSession, sourceIp?: string | null): Promise<
  | { status: "cancelled" }
  | { status: "not_found" }
  | { status: "not_cancellable" }
> {
  const op = await prisma.deploymentOperation.findUnique({ where: { id: operationId } });
  if (!op) return { status: "not_found" };
  if (!ACTIVE_STATES.includes(op.state)) return { status: "not_cancellable" };

  await logAuditEvent({
    actorUserId: actor.userId, actorEmail: actor.email, actorRole: actor.role,
    action: "DEPLOYMENT_CANCEL_REQUESTED", targetType: "DEPLOYMENT_OPERATION", targetId: operationId,
    metadata: { deploymentId: op.deploymentId }, result: "SUCCESS", sourceIp: sourceIp ?? null
  });

  void finalizeCancellation(operationId);
  return { status: "cancelled" };
}

async function finalizeCancellation(operationId: string): Promise<void> {
  const op = await prisma.deploymentOperation.findUnique({
    where: { id: operationId },
    include: { deployment: { include: { project: { include: { node: true } } } } }
  });
  if (!op) return;

  const node = op.deployment.project.node;
  await nodeAgentClient.abortDeployment(node, { deploymentId: op.deploymentId, operationId });

  // Verify actual runtime before concluding.
  const verify = op.revisionId
    ? await nodeAgentClient.verifyDeployment(node, {
        deploymentId: op.deploymentId, operationId, revisionNumber: (await prisma.deploymentRevision.findUnique({ where: { id: op.revisionId } }))?.revisionNumber ?? 0
      })
    : null;

  const runtimeChanged = verify !== null && (verify.verdict === "CONVERGED_HEALTHY" || verify.verdict === "CONVERGED_DEGRADED" || verify.verdict === "DRIFTED");
  const runtimeState = verify?.verdict === "CONVERGED_HEALTHY" ? "CONVERGED" : verify?.verdict === "CONVERGED_DEGRADED" ? "DEGRADED" : "DRIFTED";

  await prisma.deployment.update({
    where: { id: op.deploymentId },
    data: { currentReleaseId: null, runtimeState: runtimeState as "CONVERGED" | "DEGRADED" | "DRIFTED" }
  });
  await finish(operationId, "CANCELLED", null, { cancelled: true, runtimeChanged, runtimeState });
}

/**
 * Recovery sweep: resolve stale DeploymentOperations WITHOUT blindly re-applying.
 * Re-runs verify (idempotent read) to learn the true runtime state.
 *
 * Only operations that have genuinely STALLED are swept — a fresh REQUESTED/
 * QUEUED/RUNNING operation must never be finalised by the sweeper racing the
 * in-flight executor. The staleness threshold comfortably exceeds the worst-case
 * legitimate execution time (pull 300s + apply 120s + verify grace 30s).
 */
const STALE_OPERATION_MS = 10 * 60_000;

export async function sweepStaleDeploymentOperations(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_OPERATION_MS);
  const stale = await prisma.deploymentOperation.findMany({
    where: {
      state: { in: ACTIVE_STATES },
      OR: [
        // RUNNING ops stalled past the threshold (startedAt set).
        { startedAt: { lt: cutoff } },
        // REQUESTED/QUEUED ops that never started within the threshold.
        { startedAt: null, requestedAt: { lt: cutoff } }
      ]
    },
    select: { id: true }
  });
  for (const op of stale) {
    await recoverOperation(op.id).catch(() => undefined);
  }
  return stale.length;
}

async function recoverOperation(operationId: string): Promise<void> {
  const op = await prisma.deploymentOperation.findUnique({
    where: { id: operationId },
    include: { deployment: { include: { project: { include: { node: true } } } } }
  });
  if (!op) return;
  const node = op.deployment.project.node;
  const revision = op.revisionId ? await prisma.deploymentRevision.findUnique({ where: { id: op.revisionId } }) : null;

  const verify = revision
    ? await nodeAgentClient.verifyDeployment(node, {
        deploymentId: op.deploymentId, operationId, revisionNumber: revision.revisionNumber
      })
    : null;

  if (verify && (verify.verdict === "CONVERGED_HEALTHY" || verify.verdict === "CONVERGED_DEGRADED")) {
    // Conclusively converged — finalize (healthy success, degraded failure).
    const healthy = verify.verdict === "CONVERGED_HEALTHY";
    const frozenSecrets = ((op.result as Record<string, unknown>)?.frozenSecrets ?? []) as FrozenSecret[];
    const releaseId = await createRelease({
      deploymentId: op.deploymentId, revisionId: op.revisionId!, operationId,
      healthVerdict: healthy ? "HEALTHY" : "DEGRADED",
      composeVersion: node.composeVersion ?? null,
      images: buildReleaseImages(revision?.composeCanonical ?? "", verify.services),
      secrets: frozenSecrets.map((f) => ({ secretId: f.secretId, secretVersionId: f.versionId, key: f.key, versionNumber: f.versionNumber }))
    });
    await prisma.deployment.update({
      where: { id: op.deploymentId },
      data: healthy
        ? { currentReleaseId: releaseId, lastHealthyReleaseId: releaseId, runtimeState: "CONVERGED" }
        : { currentReleaseId: releaseId, runtimeState: "DEGRADED" }
    });
    await finish(operationId, healthy ? "SUCCEEDED" : "FAILED", healthy ? null : "health verification failed", {
      runtimeConverged: true, health: healthy ? "HEALTHY" : "DEGRADED", releaseId, recovered: true
    });
  } else {
    await prisma.deployment.update({
      where: { id: op.deploymentId },
      data: { currentReleaseId: null, runtimeState: "DRIFTED" }
    });
    await finish(operationId, "FAILED", "interrupted during deployment", { runtimeConverged: false, runtimeState: "DRIFTED", recovered: true });
  }
}

export async function getDeploymentOperationForSession(session: AuthSession, operationId: string) {
  const op = await prisma.deploymentOperation.findFirst({
    where: {
      id: operationId,
      ...(session.role === "ADMIN" ? {} : { OR: [{ actorUserId: session.userId }] })
    },
    include: { deployment: { select: { id: true, composeProjectName: true } } }
  });
  if (!op) return null;
  return {
    id: op.id,
    type: op.type,
    state: op.state,
    phase: op.phase,
    revisionId: op.revisionId,
    actorEmail: op.actorEmail,
    error: op.error,
    result: op.result,
    deploymentId: op.deploymentId,
    requestedAt: op.requestedAt.toISOString(),
    startedAt: op.startedAt?.toISOString() ?? null,
    finishedAt: op.finishedAt?.toISOString() ?? null
  };
}

export async function listDeploymentOperations(deploymentId: string) {
  const ops = await prisma.deploymentOperation.findMany({
    where: { deploymentId },
    orderBy: { requestedAt: "desc" },
    take: 50
  });
  return ops.map((op) => ({
    id: op.id,
    type: op.type,
    state: op.state,
    phase: op.phase,
    revisionId: op.revisionId,
    actorEmail: op.actorEmail,
    error: op.error,
    requestedAt: op.requestedAt.toISOString(),
    startedAt: op.startedAt?.toISOString() ?? null,
    finishedAt: op.finishedAt?.toISOString() ?? null
  }));
}

let deploymentSweeperTimer: ReturnType<typeof setInterval> | null = null;

export function startDeploymentSweeper(intervalMs = 30_000): void {
  if (deploymentSweeperTimer) return;
  void sweepStaleDeploymentOperations();
  deploymentSweeperTimer = setInterval(() => {
    void sweepStaleDeploymentOperations();
  }, intervalMs);
  if (typeof deploymentSweeperTimer.unref === "function") {
    deploymentSweeperTimer.unref();
  }
}

/** Resolve the default rollback target revision (previous healthy release). */
export async function getRollbackTargetRevision(deploymentId: string): Promise<string | null> {
  const deployment = await prisma.deployment.findUnique({ where: { id: deploymentId } });
  if (!deployment?.lastHealthyReleaseId) return null;
  const release = await prisma.deploymentRelease.findUnique({
    where: { id: deployment.lastHealthyReleaseId },
    select: { revisionId: true }
  });
  return release?.revisionId ?? null;
}
