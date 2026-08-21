import crypto from "node:crypto";
import { DeploymentSource, ProjectSource, Prisma } from "@prisma/client";
import { parse, stringify } from "yaml";
import { prisma } from "@/server/db";
import { nodeAgentClient } from "@/server/services/node-agent/client";
import { logAuditEvent } from "@/server/audit";
import type { AuthSession } from "@/server/auth/session";
import {
  ANALYZER_VERSION,
  analyzeComposeDefinition,
  hasBlockingFindings,
  highRiskFindings,
  secretSentinel,
  type SecurityFinding
} from "@/server/services/deployment-security";

/**
 * Managed deployment authoring + read-only validation (Phase 6A).
 *
 * Phase 6A can DEFINE and VALIDATE a future deployment, but NEVER apply it.
 * There is no pull/up/apply/rollback code path in this module. Validation is
 * read-only (`docker compose config` via the agent, using deterministic secret
 * SENTINELS — real secret values never leave the control plane and never reach
 * the agent during validation).
 */

// ---------------------------------------------------------------------------
// Canonicalization + hashing (section 8)
// ---------------------------------------------------------------------------

function sortObjectEntries(obj: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}

function sortedSecretReferences(refs: string[]): string[] {
  return Array.from(new Set(refs)).sort();
}

/**
 * Deterministic content hash of a revision's canonical representation.
 * Secret VALUES are never an input — only secret KEY references are — so
 * rotating a secret value does not change the revision hash.
 */
export function computeContentSha256(input: {
  composeCanonical: string;
  environmentSnapshot: Record<string, string>;
  secretReferences: string[];
}): string {
  const payload = JSON.stringify({
    compose: input.composeCanonical,
    environment: sortObjectEntries(input.environmentSnapshot),
    secretReferences: sortedSecretReferences(input.secretReferences)
  });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

/**
 * Strip the transient project name that `docker compose config` bakes into the
 * canonical output (derived from the throwaway temp dir used for validation).
 * The canonical must be project-name-AGNOSTIC: the real project name is applied
 * at execution time via `docker compose -p <composeProjectName>`, which then
 * derives deterministic network/volume names. Leaving the baked-in `name:` (and
 * the network/volume names derived from it) would make canonicalization
 * non-deterministic across validations and leak a random temp-dir identifier
 * into deployed network/volume names.
 */
export function stripTransientProjectName(normalized: string): string {
  let root: Record<string, unknown>;
  try {
    root = parse(normalized) as Record<string, unknown>;
  } catch {
    return normalized;
  }
  if (!root || typeof root !== "object") return normalized;

  let changed = false;
  if ("name" in root) {
    delete root.name;
    changed = true;
  }
  const networks = (root.networks ?? {}) as Record<string, Record<string, unknown>>;
  for (const key of Object.keys(networks)) {
    if (networks[key] && typeof networks[key] === "object" && "name" in networks[key]) {
      delete networks[key].name;
      changed = true;
    }
  }
  const volumes = (root.volumes ?? {}) as Record<string, Record<string, unknown>>;
  for (const key of Object.keys(volumes)) {
    if (volumes[key] && typeof volumes[key] === "object" && "name" in volumes[key]) {
      delete volumes[key].name;
      changed = true;
    }
  }

  // Nothing to strip → return the exact `docker compose config` bytes untouched.
  if (!changed) return normalized;
  return stringify(root);
}

/**
 * Build the env map sent to the agent for read-only validation: real
 * non-secret values + deterministic sentinels for declared secrets. Never
 * real secret values.
 */
export function buildValidationEnv(
  environment: Record<string, string>,
  secretReferences: string[]
): Record<string, string> {
  const env: Record<string, string> = { ...environment };
  for (const key of sortedSecretReferences(secretReferences)) {
    env[key] = secretSentinel(key);
  }
  return env;
}

// ---------------------------------------------------------------------------
// Validation orchestration (Stage A + Stage B)
// ---------------------------------------------------------------------------

export type DeploymentValidationResult = {
  nodeFound: boolean;
  nodeName: string | null;
  composeSupported: boolean;
  composeVersion: string | null;
  findings: SecurityFinding[];
  composeErrors: string[];
  composeCanonical: string | null;
  valid: boolean;
  blockedFindings: SecurityFinding[];
  highRiskFindings: SecurityFinding[];
};

export async function validateDeploymentDefinition(input: {
  nodeId: string;
  compose: string;
  environment: Record<string, string>;
  secretReferences: string[];
  policy?: "ADMIN" | "CLIENT";
}): Promise<DeploymentValidationResult> {
  const node = await prisma.node.findUnique({ where: { id: input.nodeId } });
  if (!node) {
    return {
      nodeFound: false,
      nodeName: null,
      composeSupported: false,
      composeVersion: null,
      findings: [],
      composeErrors: ["Node not found"],
      composeCanonical: null,
      valid: false,
      blockedFindings: [],
      highRiskFindings: []
    };
  }

  // Stage A — control-plane policy/input analysis (no Compose, no secrets).
  const analyzed = analyzeComposeDefinition({
    composeSource: input.compose,
    secretReferences: input.secretReferences,
    policy: input.policy ?? "ADMIN"
  });

  // Stage B — read-only `docker compose config` via the agent, using sentinels.
  const stageB = await nodeAgentClient.validateCompose(node, {
    compose: input.compose,
    env: buildValidationEnv(input.environment, input.secretReferences)
  });

  const blocked = analyzed.findings.filter((f) => f.severity === "BLOCKED");
  const highRisk = highRiskFindings(analyzed.findings);
  const valid =
    analyzed.parseOk &&
    node.isActive &&
    stageB.composeSupported &&
    stageB.valid &&
    !hasBlockingFindings(analyzed.findings);

  const composeErrors = stageB.composeSupported
    ? stageB.errors
    : ["Docker Compose v2 is not available on this node."];

  return {
    nodeFound: true,
    nodeName: node.name,
    composeSupported: stageB.composeSupported,
    composeVersion: stageB.composeVersion,
    findings: analyzed.findings,
    composeErrors,
    composeCanonical: stageB.valid && stageB.normalized ? stripTransientProjectName(stageB.normalized) : null,
    valid,
    blockedFindings: blocked,
    highRiskFindings: highRisk
  };
}

// ---------------------------------------------------------------------------
// Slug / compose-project-name uniqueness (mirrors compose.ts::uniqueSlugForNode)
// ---------------------------------------------------------------------------

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "managed"
  );
}

async function uniqueSlugForNode(nodeId: string, base: string): Promise<string> {
  const baseSlug = slugify(base);
  const existing = await prisma.project.findMany({
    where: { nodeId, slug: { startsWith: baseSlug } },
    select: { slug: true }
  });
  const used = new Set(existing.map((p) => p.slug));
  if (!used.has(baseSlug)) return baseSlug;
  let i = 2;
  for (;;) {
    const candidate = `${baseSlug.slice(0, 56)}-${i}`;
    if (!used.has(candidate)) return candidate;
    i += 1;
  }
}

// ---------------------------------------------------------------------------
// Result unions
// ---------------------------------------------------------------------------

export type CreateDeploymentResult =
  | { status: "created"; deploymentId: string; projectId: string; revisionId: string; revisionNumber: number }
  | { status: "node_not_found" }
  | { status: "compose_unavailable"; message: string }
  | { status: "invalid"; findings: SecurityFinding[]; composeErrors: string[] }
  | { status: "ack_required"; highRiskFindings: SecurityFinding[] }
  | { status: "compose_project_taken"; existingName: string };

export type CreateRevisionResult =
  | { status: "created"; revisionId: string; revisionNumber: number; deduplicated: boolean }
  | { status: "deployment_not_found" }
  | { status: "compose_unavailable"; message: string }
  | { status: "invalid"; findings: SecurityFinding[]; composeErrors: string[] }
  | { status: "ack_required"; highRiskFindings: SecurityFinding[] };

// ---------------------------------------------------------------------------
// Create managed deployment definition (authoring only — no Docker mutation)
// ---------------------------------------------------------------------------

export async function createDeployment(input: {
  nodeId: string;
  name: string;
  slug?: string;
  description?: string | null;
  clientAccountId?: string | null;
  composeProjectName: string;
  compose: string;
  environment: Record<string, string>;
  secretReferences: string[];
  acknowledgedFindings: string[];
  deployNote?: string | null;
  policy?: "ADMIN" | "CLIENT";
  /** When adopting into an ALREADY-EXISTING project (compose adoption), the
   *  target project row is reused instead of creating a new one, and the
   *  (nodeId, composeProject) uniqueness check skips that same row. */
  adoptExistingProjectId?: string;
  actor: AuthSession;
  sourceIp?: string | null;
}): Promise<CreateDeploymentResult> {
  const policy = input.policy ?? "ADMIN";
  const validation = await validateDeploymentDefinition({
    nodeId: input.nodeId,
    compose: input.compose,
    environment: input.environment,
    secretReferences: input.secretReferences,
    policy
  });

  if (!validation.nodeFound) return { status: "node_not_found" };
  if (!validation.composeSupported) {
    return {
      status: "compose_unavailable",
      message: "Docker Compose v2 is not available on this node."
    };
  }
  if (validation.blockedFindings.length > 0 || !validation.composeCanonical) {
    return { status: "invalid", findings: validation.findings, composeErrors: validation.composeErrors };
  }

  const missingAcks = validation.highRiskFindings.filter(
    (f) => !input.acknowledgedFindings.includes(f.fingerprint)
  );
  if (missingAcks.length > 0) {
    return { status: "ack_required", highRiskFindings: missingAcks };
  }

  const contentSha256 = computeContentSha256({
    composeCanonical: validation.composeCanonical,
    environmentSnapshot: input.environment,
    secretReferences: input.secretReferences
  });

  // composeProjectName must be unique per node (Project @@unique([nodeId, composeProject])),
  // EXCEPT when adopting into an already-existing project: the target project
  // IS that row, so the managed definition is authored onto it instead.
  const existingProject = await prisma.project.findFirst({
    where: { nodeId: input.nodeId, composeProject: input.composeProjectName },
    select: { id: true, name: true }
  });
  if (existingProject && existingProject.id !== input.adoptExistingProjectId) {
    return { status: "compose_project_taken", existingName: existingProject.name };
  }
  const adoptingExisting = Boolean(input.adoptExistingProjectId && existingProject);
  if (input.adoptExistingProjectId && !existingProject) {
    return { status: "invalid", findings: [], composeErrors: ["Adoption target project not found on this node"] };
  }

  const slug = input.slug?.trim()
    ? await uniqueSlugForNode(input.nodeId, input.slug.trim())
    : await uniqueSlugForNode(input.nodeId, input.name);

  const secretRefs = sortedSecretReferences(input.secretReferences);
  const envSnapshot = sortObjectEntries(input.environment);

  const result = await prisma.$transaction(async (tx) => {
    const project = adoptingExisting && existingProject
      ? await tx.project.update({
          where: { id: existingProject.id },
          data: {
            name: input.name,
            description: input.description ?? null,
            clientAccountId: input.clientAccountId
          }
        })
      : await tx.project.create({
          data: {
            name: input.name,
            slug,
            description: input.description ?? null,
            source: ProjectSource.COMPOSE,
            composeProject: input.composeProjectName,
            clientAccountId: input.clientAccountId,
            nodeId: input.nodeId,
            isActive: true
          }
        });

    const deployment = await tx.deployment.create({
      data: {
        projectId: project.id,
        source: DeploymentSource.HOSTPANEL,
        composeProjectName: input.composeProjectName
      }
    });

    const revision = await tx.deploymentRevision.create({
      data: {
        deploymentId: deployment.id,
        revisionNumber: 1,
        source: DeploymentSource.HOSTPANEL,
        policy,
        composeSource: input.compose,
        composeCanonical: validation.composeCanonical as string,
        environmentSnapshot: envSnapshot,
        secretReferences: secretRefs,
        contentSha256,
        deployNote: input.deployNote ?? null,
        analyzerVersion: ANALYZER_VERSION,
        createdById: input.actor.userId
      }
    });

    await persistFindings(tx, revision.id, validation.findings);
    await persistAcknowledgements(tx, revision.id, input.acknowledgedFindings, validation.findings, input.actor);

    return { projectId: project.id, deploymentId: deployment.id, revisionId: revision.id };
  });

  await logAuditEvent({
    actorUserId: input.actor.userId,
    actorEmail: input.actor.email,
    actorRole: input.actor.role,
    clientAccountId: input.clientAccountId ?? null,
    action: "DEPLOYMENT_DEFINITION_CREATED",
    targetType: "DEPLOYMENT",
    targetId: result.deploymentId,
    metadata: {
      projectId: result.projectId,
      nodeId: input.nodeId,
      composeProjectName: input.composeProjectName,
      revisionNumber: 1,
      contentSha256,
      findingCount: validation.findings.length
    },
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null
  });

  return {
    status: "created",
    deploymentId: result.deploymentId,
    projectId: result.projectId,
    revisionId: result.revisionId,
    revisionNumber: 1
  };
}

// ---------------------------------------------------------------------------
// Create a new immutable revision on an existing managed deployment
// ---------------------------------------------------------------------------

export async function createRevision(input: {
  deploymentId: string;
  compose: string;
  environment: Record<string, string>;
  secretReferences: string[];
  acknowledgedFindings: string[];
  deployNote?: string | null;
  policy?: "ADMIN" | "CLIENT";
  actor: AuthSession;
  sourceIp?: string | null;
}): Promise<CreateRevisionResult> {
  const deployment = await prisma.deployment.findUnique({
    where: { id: input.deploymentId },
    include: { project: { select: { nodeId: true } } }
  });
  if (!deployment) return { status: "deployment_not_found" };

  const policy = input.policy ?? "ADMIN";

  const validation = await validateDeploymentDefinition({
    nodeId: deployment.project.nodeId,
    compose: input.compose,
    environment: input.environment,
    secretReferences: input.secretReferences,
    policy
  });

  if (!validation.composeSupported) {
    return {
      status: "compose_unavailable",
      message: "Docker Compose v2 is not available on this node."
    };
  }
  if (validation.blockedFindings.length > 0 || !validation.composeCanonical) {
    return { status: "invalid", findings: validation.findings, composeErrors: validation.composeErrors };
  }

  const missingAcks = validation.highRiskFindings.filter(
    (f) => !input.acknowledgedFindings.includes(f.fingerprint)
  );
  if (missingAcks.length > 0) {
    return { status: "ack_required", highRiskFindings: missingAcks };
  }

  const contentSha256 = computeContentSha256({
    composeCanonical: validation.composeCanonical,
    environmentSnapshot: input.environment,
    secretReferences: input.secretReferences
  });

  const secretRefs = sortedSecretReferences(input.secretReferences);
  const envSnapshot = sortObjectEntries(input.environment);

  const result = await prisma.$transaction(async (tx) => {
    // Dedup: identical canonical content maps to the existing revision.
    const existing = await tx.deploymentRevision.findUnique({
      where: { deploymentId_contentSha256: { deploymentId: deployment.id, contentSha256 } },
      select: { id: true, revisionNumber: true }
    });
    if (existing) {
      return { revisionId: existing.id, revisionNumber: existing.revisionNumber, deduplicated: true };
    }

    const latest = await tx.deploymentRevision.findFirst({
      where: { deploymentId: deployment.id },
      orderBy: { revisionNumber: "desc" },
      select: { revisionNumber: true }
    });
    const nextNumber = (latest?.revisionNumber ?? 0) + 1;

    const revision = await tx.deploymentRevision.create({
      data: {
        deploymentId: deployment.id,
        revisionNumber: nextNumber,
        source: DeploymentSource.HOSTPANEL,
        policy,
        composeSource: input.compose,
        composeCanonical: validation.composeCanonical as string,
        environmentSnapshot: envSnapshot,
        secretReferences: secretRefs,
        contentSha256,
        deployNote: input.deployNote ?? null,
        analyzerVersion: ANALYZER_VERSION,
        createdById: input.actor.userId
      }
    });

    await persistFindings(tx, revision.id, validation.findings);
    await persistAcknowledgements(tx, revision.id, input.acknowledgedFindings, validation.findings, input.actor);

    return { revisionId: revision.id, revisionNumber: nextNumber, deduplicated: false };
  });

  await logAuditEvent({
    actorUserId: input.actor.userId,
    actorEmail: input.actor.email,
    actorRole: input.actor.role,
    action: "DEPLOYMENT_REVISION_CREATED",
    targetType: "DEPLOYMENT_REVISION",
    targetId: result.revisionId,
    metadata: {
      deploymentId: deployment.id,
      revisionNumber: result.revisionNumber,
      contentSha256,
      deduplicated: result.deduplicated
    },
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null
  });

  return {
    status: "created",
    revisionId: result.revisionId,
    revisionNumber: result.revisionNumber,
    deduplicated: result.deduplicated
  };
}

// ---------------------------------------------------------------------------
// Persistence helpers (run inside the creation transaction)
// ---------------------------------------------------------------------------

type Tx = Prisma.TransactionClient;

async function persistFindings(
  tx: Tx,
  revisionId: string,
  findings: SecurityFinding[]
): Promise<void> {
  if (findings.length === 0) return;
  await tx.deploymentRevisionSecurityFinding.createMany({
    data: findings.map((f) => ({
      revisionId,
      ruleId: f.ruleId,
      fingerprint: f.fingerprint,
      severity: f.severity,
      category: f.category,
      service: f.service,
      resourcePath: f.resourcePath,
      settingValue: f.settingValue,
      message: f.message,
      analyzerVersion: f.analyzerVersion
    }))
  });
}

async function persistAcknowledgements(
  tx: Tx,
  revisionId: string,
  acknowledgedFingerprints: string[],
  findings: SecurityFinding[],
  actor: AuthSession
): Promise<void> {
  const byFingerprint = new Map(findings.map((f) => [f.fingerprint, f]));
  const acks = acknowledgedFingerprints
    .filter((fp) => {
      const f = byFingerprint.get(fp);
      return f && f.severity === "HIGH_RISK";
    })
    .map((fp) => ({
      revisionId,
      findingFingerprint: fp,
      ruleId: byFingerprint.get(fp)!.ruleId,
      acknowledgedById: actor.userId
    }));
  if (acks.length === 0) return;
  await tx.deploymentSecurityAcknowledgement.createMany({ data: acks });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getDeployment(deploymentId: string) {
  const deployment = await prisma.deployment.findUnique({
    where: { id: deploymentId },
    include: {
      project: {
        select: {
          id: true,
          name: true,
          slug: true,
          source: true,
          composeProject: true,
          nodeId: true,
          node: { select: { id: true, name: true } }
        }
      }
    }
  });
  if (!deployment) return null;
  return {
    id: deployment.id,
    projectId: deployment.projectId,
    source: deployment.source,
    composeProjectName: deployment.composeProjectName,
    currentReleaseId: deployment.currentReleaseId,
    lastHealthyReleaseId: deployment.lastHealthyReleaseId,
    runtimeState: deployment.runtimeState,
    ownershipMode: "MANAGED_COMPOSE",
    project: deployment.project,
    createdAt: deployment.createdAt.toISOString(),
    updatedAt: deployment.updatedAt.toISOString()
  };
}

export async function listRevisions(deploymentId: string) {
  const revisions = await prisma.deploymentRevision.findMany({
    where: { deploymentId },
    orderBy: { revisionNumber: "desc" },
    select: {
      id: true,
      revisionNumber: true,
      source: true,
      sourceRef: true,
      contentSha256: true,
      deployNote: true,
      analyzerVersion: true,
      createdAt: true,
      createdBy: { select: { email: true } }
    }
  });
  return revisions.map((r) => ({
    id: r.id,
    revisionNumber: r.revisionNumber,
    source: r.source,
    sourceRef: r.sourceRef,
    contentSha256: r.contentSha256,
    deployNote: r.deployNote,
    analyzerVersion: r.analyzerVersion,
    createdAt: r.createdAt.toISOString(),
    createdBy: r.createdBy?.email ?? null
  }));
}

export async function getRevision(deploymentId: string, revisionId: string) {
  const revision = await prisma.deploymentRevision.findFirst({
    where: { id: revisionId, deploymentId },
    include: {
      createdBy: { select: { email: true } },
      findings: true
    }
  });
  if (!revision) return null;
  return {
    id: revision.id,
    deploymentId: revision.deploymentId,
    revisionNumber: revision.revisionNumber,
    source: revision.source,
    sourceRef: revision.sourceRef,
    composeSource: revision.composeSource,
    composeCanonical: revision.composeCanonical,
    environmentSnapshot: revision.environmentSnapshot,
    secretReferences: revision.secretReferences,
    contentSha256: revision.contentSha256,
    deployNote: revision.deployNote,
    analyzerVersion: revision.analyzerVersion,
    createdAt: revision.createdAt.toISOString(),
    createdBy: revision.createdBy?.email ?? null,
    findings: revision.findings
  };
}

/**
 * Grant-scoped minimal deployment status for CLIENT roles. Never returns
 * compose source/canonical, environmentSnapshot, secretReferences, secret
 * metadata, or finding internals — only status metadata.
 */
export async function getClientDeploymentStatus(
  session: AuthSession,
  projectId: string
): Promise<{
  managed: boolean;
  deploymentId: string | null;
  isOwner: boolean;
  runtimeState: string | null;
  currentReleaseId: string | null;
  lastHealthyReleaseId: string | null;
  createdAt: string | null;
  activeOperation: {
    id: string;
    type: string;
    state: string;
    phase: string | null;
    actorEmail: string | null;
    startedAt: string | null;
  } | null;
} | null> {
  if (!session.clientAccountId) return null;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      clientAccountId: true,
      deployment: { select: { id: true, currentReleaseId: true, lastHealthyReleaseId: true, runtimeState: true, createdAt: true } }
    }
  });
  if (!project) return null;

  const ownClient = project.clientAccountId === session.clientAccountId;
  const grant = ownClient
    ? null
    : await prisma.accessGrant.findFirst({
        where: { projectId, clientAccountId: session.clientAccountId, isActive: true }
      });
  if (!ownClient && !grant) return null;

  if (!project.deployment) {
    return { managed: false, deploymentId: null, isOwner: ownClient, runtimeState: null, currentReleaseId: null, lastHealthyReleaseId: null, createdAt: null, activeOperation: null };
  }

  const activeOp = ownClient
    ? await prisma.deploymentOperation.findFirst({
        where: { deploymentId: project.deployment.id, state: { in: ["REQUESTED", "QUEUED", "RUNNING"] } },
        orderBy: { requestedAt: "desc" },
        select: { id: true, type: true, state: true, phase: true, actorEmail: true, startedAt: true }
      })
    : null;

  return {
    managed: true,
    // deploymentId is only useful to the OWNING client (grant recipients get
    // status metadata only — the lifecycle routes independently re-check
    // ownership, but there's no reason to hand a grant recipient the id).
    deploymentId: ownClient ? project.deployment.id : null,
    isOwner: ownClient,
    runtimeState: project.deployment.runtimeState,
    currentReleaseId: project.deployment.currentReleaseId,
    lastHealthyReleaseId: project.deployment.lastHealthyReleaseId,
    createdAt: project.deployment.createdAt.toISOString(),
    activeOperation: activeOp
      ? {
          id: activeOp.id,
          type: activeOp.type,
          state: activeOp.state,
          phase: activeOp.phase,
          actorEmail: activeOp.actorEmail,
          startedAt: activeOp.startedAt?.toISOString() ?? null
        }
      : null
  };
}

/**
 * Re-analyze a stored immutable revision against the CURRENT analyzer policy
 * (used by future deployment-eligibility checks). Never mutates the revision.
 * Returns current findings + which HIGH_RISK findings are not yet covered by
 * an acknowledgement.
 */
export async function reanalyzeRevision(revisionId: string): Promise<{
  revision: { id: string; revisionNumber: number; analyzerVersion: string };
  findings: SecurityFinding[];
  acknowledgements: { fingerprint: string; ruleId: string; acknowledgedAt: string }[];
  uncoveredHighRisk: SecurityFinding[];
} | null> {
  const revision = await prisma.deploymentRevision.findUnique({
    where: { id: revisionId },
    include: { deploymentSecurityAcknowledgements: true }
  });
  if (!revision) return null;

  const analyzed = analyzeComposeDefinition({
    composeSource: revision.composeSource,
    secretReferences: revision.secretReferences,
    policy: revision.policy
  });

  const acked = new Set(revision.deploymentSecurityAcknowledgements.map((a) => a.findingFingerprint));
  const uncoveredHighRisk = analyzed.findings.filter(
    (f) => f.severity === "HIGH_RISK" && !acked.has(f.fingerprint)
  );

  return {
    revision: { id: revision.id, revisionNumber: revision.revisionNumber, analyzerVersion: revision.analyzerVersion },
    findings: analyzed.findings,
    acknowledgements: revision.deploymentSecurityAcknowledgements.map((a) => ({
      fingerprint: a.findingFingerprint,
      ruleId: a.ruleId,
      acknowledgedAt: a.acknowledgedAt.toISOString()
    })),
    uncoveredHighRisk
  };
}

/**
 * Authorize a HIGH_RISK finding acknowledgement. Separate from the immutable
 * revision. BLOCKED findings can never be acknowledged.
 */
export async function acknowledgeSecurityFinding(input: {
  revisionId: string;
  fingerprint: string;
  actor: AuthSession;
  sourceIp?: string | null;
}): Promise<
  | { status: "acknowledged" }
  | { status: "finding_not_found" }
  | { status: "not_acknowledgeable" }
> {
  const revision = await prisma.deploymentRevision.findUnique({
    where: { id: input.revisionId },
    select: { id: true, deploymentId: true }
  });
  if (!revision) return { status: "finding_not_found" };

  const finding = await prisma.deploymentRevisionSecurityFinding.findUnique({
    where: { revisionId_fingerprint: { revisionId: input.revisionId, fingerprint: input.fingerprint } }
  });
  if (!finding) return { status: "finding_not_found" };
  if (finding.severity !== "HIGH_RISK") return { status: "not_acknowledgeable" };

  await prisma.deploymentSecurityAcknowledgement.upsert({
    where: {
      revisionId_findingFingerprint: {
        revisionId: input.revisionId,
        findingFingerprint: input.fingerprint
      }
    },
    create: {
      revisionId: input.revisionId,
      findingFingerprint: input.fingerprint,
      ruleId: finding.ruleId,
      acknowledgedById: input.actor.userId
    },
    update: {
      acknowledgedById: input.actor.userId,
      acknowledgedAt: new Date()
    }
  });

  await logAuditEvent({
    actorUserId: input.actor.userId,
    actorEmail: input.actor.email,
    actorRole: input.actor.role,
    action: "DEPLOYMENT_SECURITY_ACKNOWLEDGED",
    targetType: "DEPLOYMENT_REVISION",
    targetId: input.revisionId,
    metadata: { ruleId: finding.ruleId, fingerprint: input.fingerprint },
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null
  });

  return { status: "acknowledged" };
}

/**
 * Deployment status for the ADMIN workload detail / overview card (Phase 6C).
 * Read-only summary; never compose content or secret material.
 */
export async function getAdminWorkloadDeploymentStatus(projectId: string): Promise<{
  managed: boolean;
  deploymentId: string | null;
  runtimeState: string | null;
  currentRelease: {
    id: string;
    displayNumber: number | null;
    revisionId: string;
    revisionNumber: number;
    healthVerdict: string;
    appliedAt: string | null;
    operationId: string | null;
    operationType: string | null;
    operationState: string | null;
    actorEmail: string | null;
  } | null;
  lastHealthyRelease: { id: string; displayNumber: number | null; revisionNumber: number } | null;
  activeOperation: {
    id: string;
    type: string;
    state: string;
    phase: string | null;
    actorEmail: string | null;
    startedAt: string | null;
  } | null;
} | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      deployment: {
        select: { id: true, runtimeState: true, currentReleaseId: true, lastHealthyReleaseId: true }
      }
    }
  });
  if (!project) return null;
  const dep = project.deployment;
  if (!dep) {
    return {
      managed: false,
      deploymentId: null,
      runtimeState: null,
      currentRelease: null,
      lastHealthyRelease: null,
      activeOperation: null
    };
  }

  const releaseDisplayNumber = async (releaseId: string): Promise<number | null> => {
    const r = await prisma.deploymentRelease.findUnique({ where: { id: releaseId }, select: { createdAt: true } });
    if (!r) return null;
    return prisma.deploymentRelease.count({
      where: {
        deploymentId: dep.id,
        OR: [{ createdAt: { lt: r.createdAt } }, { createdAt: r.createdAt, id: { lte: releaseId } }]
      }
    });
  };

  const [currentRelease, lastHealthyRelease, activeOperation] = await Promise.all([
    dep.currentReleaseId
      ? prisma.deploymentRelease.findUnique({
          where: { id: dep.currentReleaseId },
          select: {
            id: true,
            revisionId: true,
            healthVerdict: true,
            appliedAt: true,
            operationId: true,
            revision: { select: { revisionNumber: true } }
          }
        })
      : null,
    dep.lastHealthyReleaseId
      ? prisma.deploymentRelease.findUnique({
          where: { id: dep.lastHealthyReleaseId },
          select: { id: true, revision: { select: { revisionNumber: true } } }
        })
      : null,
    prisma.deploymentOperation.findFirst({
      where: { deploymentId: dep.id, state: { in: ["REQUESTED", "QUEUED", "RUNNING"] } },
      orderBy: { requestedAt: "desc" },
      select: { id: true, type: true, state: true, phase: true, actorEmail: true, startedAt: true }
    })
  ]);

  const currentOperation = currentRelease?.operationId
    ? await prisma.deploymentOperation.findUnique({
        where: { id: currentRelease.operationId },
        select: { type: true, state: true, actorEmail: true }
      })
    : null;

  return {
    managed: true,
    deploymentId: dep.id,
    runtimeState: dep.runtimeState,
    currentRelease: currentRelease
      ? {
          id: currentRelease.id,
          displayNumber: await releaseDisplayNumber(currentRelease.id),
          revisionId: currentRelease.revisionId,
          revisionNumber: currentRelease.revision.revisionNumber,
          healthVerdict: currentRelease.healthVerdict,
          appliedAt: currentRelease.appliedAt?.toISOString() ?? null,
          operationId: currentRelease.operationId,
          operationType: currentOperation?.type ?? null,
          operationState: currentOperation?.state ?? null,
          actorEmail: currentOperation?.actorEmail ?? null
        }
      : null,
    lastHealthyRelease: lastHealthyRelease
      ? {
          id: lastHealthyRelease.id,
          displayNumber: await releaseDisplayNumber(lastHealthyRelease.id),
          revisionNumber: lastHealthyRelease.revision.revisionNumber
        }
      : null,
    activeOperation: activeOperation
      ? {
          id: activeOperation.id,
          type: activeOperation.type,
          state: activeOperation.state,
          phase: activeOperation.phase,
          actorEmail: activeOperation.actorEmail,
          startedAt: activeOperation.startedAt?.toISOString() ?? null
        }
      : null
  };
}
