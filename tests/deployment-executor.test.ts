import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DeploymentSource, ProjectSource } from "@prisma/client";
import { prisma } from "./helpers/db";
import { resetDatabase } from "./setup";
import { seedWorld, sessionFor } from "./helpers/fixtures";
import { createSecret, rotateSecret } from "@/server/services/deployment-secrets";
import { recomputePlanHash } from "@/server/services/deployment-plan";
import { requestDeploymentOperation, requestCancellation, sweepStaleDeploymentOperations, getRollbackTarget } from "@/server/services/deployment-executor";

// The eligibility gate requires the Agent CA to exist; point it at a throwaway dir.
const pkiTmp = fs.mkdtempSync(path.join(os.tmpdir(), "hostpanel-exec-pki-"));
process.env.HOSTPANEL_AGENT_CA_CERT_PATH = path.join(pkiTmp, "ca.pem");
process.env.HOSTPANEL_AGENT_CA_KEY_PATH = path.join(pkiTmp, "ca-key.pem");

const { bootstrapCa, caExists } = await import("@/server/security/agent-pki");

const agent = vi.hoisted(() => ({
  prepareDeployment: vi.fn(),
  pullDeployment: vi.fn(),
  applyDeployment: vi.fn(),
  verifyDeployment: vi.fn(),
  abortDeployment: vi.fn(),
  getDeploymentState: vi.fn(),
  inspectContainerFull: vi.fn(),
  removeContainer: vi.fn()
}));

vi.mock("@/server/services/node-agent/client", () => ({ nodeAgentClient: agent }));

beforeAll(() => resetDatabase());
if (!caExists()) bootstrapCa({ years: 1 });

function stubSuccess() {
  agent.prepareDeployment.mockResolvedValue({ ok: true, prepared: true, revisionNumber: 1 });
  agent.pullDeployment.mockResolvedValue({ ok: true, images: [] });
  agent.applyDeployment.mockResolvedValue({ ok: true, applied: true });
  agent.verifyDeployment.mockResolvedValue({ verdict: "CONVERGED_HEALTHY", services: [{ name: "web", status: "running", health: null, restartCount: 0 }] });
  agent.abortDeployment.mockResolvedValue(true);
  // Adoption stale-container reconcile path: default to "not adopted" (no
  // inspect result) and successful removal.
  agent.inspectContainerFull.mockResolvedValue({ nodeOnline: true, inspect: null });
  agent.removeContainer.mockResolvedValue(true);
}

beforeEach(() => {
  vi.clearAllMocks();
  stubSuccess();
});

async function makeManaged(actor: ReturnType<typeof sessionFor>, revisionNumber = 1) {
  const world = await seedWorld();
  await prisma.node.update({
    where: { id: world.node1.id },
    data: { transportMode: "TLS_VERIFIED", composeSupported: true, composeVersion: "v2.40.3", tlsApiBaseUrl: "https://agent:9081" }
  });
  // The eligibility gate requires an ACTIVE certificate record; the executor
  // tests mock the agent client, so a metadata row suffices (real TLS
  // verification is covered by tests/agent-tls-transport.test.ts).
  await prisma.nodeAgentCertificate.create({
    data: {
      nodeId: world.node1.id,
      serialNumber: "01" + crypto.randomBytes(4).toString("hex"),
      fingerprintSha256: crypto.randomBytes(32).toString("hex"),
      subjectIdentity: "node-test.agents.hostpanel.internal",
      status: "ACTIVE",
      notBefore: new Date(Date.now() - 60_000),
      notAfter: new Date(Date.now() + 30 * 86_400_000)
    }
  });
  const suffix = crypto.randomUUID().slice(0, 8);
  const project = await prisma.project.create({
    data: { name: `Exec ${suffix}`, slug: `exec-${suffix}`, source: ProjectSource.COMPOSE, composeProject: `ecp-${suffix}`, nodeId: world.node1.id, isActive: true }
  });
  const deployment = await prisma.deployment.create({
    data: { projectId: project.id, source: DeploymentSource.HOSTPANEL, composeProjectName: project.composeProject ?? `ecp-${suffix}` }
  });
  const compose = "services:\n  web:\n    image: nginx:stable\n    environment:\n      DB: ${DB_PASSWORD}\n";
  const revision = await prisma.deploymentRevision.create({
    data: {
      deploymentId: deployment.id, revisionNumber, source: DeploymentSource.HOSTPANEL,
      composeSource: compose, composeCanonical: compose,
      environmentSnapshot: {}, secretReferences: ["DB_PASSWORD"],
      contentSha256: crypto.randomUUID(), analyzerVersion: "1"
    }
  });
  await createSecret({ deploymentId: deployment.id, key: "DB_PASSWORD", value: "secret-value-1", actor });
  return { world, project, deployment, revision };
}

async function waitForTerminal(operationId: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const op = await prisma.deploymentOperation.findUniqueOrThrow({ where: { id: operationId } });
    if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(op.state)) return;
    if (Date.now() - start > timeoutMs) throw new Error("operation did not reach terminal state");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("managed deployment executor", () => {
  it("successful deploy converges and creates a healthy Release", async () => {
    const world = await seedWorld();
    const { deployment, revision } = await makeManaged(sessionFor(world.adminA));
    const planHash = (await recomputePlanHash(deployment.id, revision.id))!;

    const result = await requestDeploymentOperation({
      deploymentId: deployment.id, type: "DEPLOY", revisionId: revision.id, planHash, actor: sessionFor(world.adminA)
    });
    expect(result.status).toBe("created");
    await waitForTerminal((result as { operationId: string }).operationId);

    expect(agent.applyDeployment).toHaveBeenCalled();
    const d = await prisma.deployment.findUniqueOrThrow({ where: { id: deployment.id } });
    expect(d.currentReleaseId).not.toBeNull();
    expect(d.lastHealthyReleaseId).not.toBeNull();
    expect(d.runtimeState).toBe("CONVERGED");

    const release = await prisma.deploymentRelease.findUniqueOrThrow({ where: { id: d.currentReleaseId! } });
    expect(release.healthVerdict).toBe("HEALTHY");
    expect(release.revisionId).toBe(revision.id);
    // Image + secret snapshots recorded, secret VALUE not present.
    expect(await prisma.deploymentReleaseImage.count({ where: { releaseId: release.id } })).toBe(1);
    const secretSnap = await prisma.deploymentReleaseSecret.findFirstOrThrow({ where: { releaseId: release.id } });
    expect(secretSnap.key).toBe("DB_PASSWORD");
    expect(JSON.stringify(secretSnap)).not.toContain("secret-value-1");
  });

  it("pull failure aborts before apply (no Docker mutation)", async () => {
    const world = await seedWorld();
    const { deployment, revision } = await makeManaged(sessionFor(world.adminA));
    agent.pullDeployment.mockResolvedValue({ ok: false, images: [], error: "pull failed" });
    const planHash = (await recomputePlanHash(deployment.id, revision.id))!;

    const result = await requestDeploymentOperation({ deploymentId: deployment.id, type: "DEPLOY", revisionId: revision.id, planHash, actor: sessionFor(world.adminA) });
    expect(result.status).toBe("created");
    await waitForTerminal((result as { operationId: string }).operationId);

    expect(agent.applyDeployment).not.toHaveBeenCalled();
    const op = await prisma.deploymentOperation.findFirstOrThrow({ where: { deploymentId: deployment.id } });
    expect(op.state).toBe("FAILED");
  });

  it("degraded verification records a DEGRADED current release and FAILED operation", async () => {
    const world = await seedWorld();
    const { deployment, revision } = await makeManaged(sessionFor(world.adminA));
    agent.verifyDeployment.mockResolvedValue({ verdict: "CONVERGED_DEGRADED", services: [{ name: "web", status: "running", health: "unhealthy", restartCount: 4 }] });
    const planHash = (await recomputePlanHash(deployment.id, revision.id))!;

    const result = await requestDeploymentOperation({ deploymentId: deployment.id, type: "DEPLOY", revisionId: revision.id, planHash, actor: sessionFor(world.adminA) });
    await waitForTerminal((result as { operationId: string }).operationId);

    const d = await prisma.deployment.findUniqueOrThrow({ where: { id: deployment.id } });
    expect(d.runtimeState).toBe("DEGRADED");
    expect(d.currentReleaseId).not.toBeNull();
    expect(d.lastHealthyReleaseId).toBeNull(); // no prior healthy release
    const release = await prisma.deploymentRelease.findUniqueOrThrow({ where: { id: d.currentReleaseId! } });
    expect(release.healthVerdict).toBe("DEGRADED");
  });

  it("drifted runtime does NOT assign a current release", async () => {
    const world = await seedWorld();
    const { deployment, revision } = await makeManaged(sessionFor(world.adminA));
    // Short grace window so a persistently-DRIFTED runtime fails fast instead of
    // polling the full default 30s window.
    await prisma.deployment.update({ where: { id: deployment.id }, data: { verifyGraceMs: 300 } });
    agent.verifyDeployment.mockResolvedValue({ verdict: "DRIFTED", services: [] });
    const planHash = (await recomputePlanHash(deployment.id, revision.id))!;

    const result = await requestDeploymentOperation({ deploymentId: deployment.id, type: "DEPLOY", revisionId: revision.id, planHash, actor: sessionFor(world.adminA) });
    await waitForTerminal((result as { operationId: string }).operationId);

    const d = await prisma.deployment.findUniqueOrThrow({ where: { id: deployment.id } });
    expect(d.runtimeState).toBe("DRIFTED");
    expect(d.currentReleaseId).toBeNull();
    expect(await prisma.deploymentRelease.count({ where: { deploymentId: deployment.id } })).toBe(0);
  });

  it("transient DRIFTED during grace window converges to a healthy release", async () => {
    const world = await seedWorld();
    const { deployment, revision } = await makeManaged(sessionFor(world.adminA));
    await prisma.deployment.update({ where: { id: deployment.id }, data: { verifyGraceMs: 10_000 } });
    // First verify reports DRIFTED (containers not yet visible), then converges.
    let calls = 0;
    agent.verifyDeployment.mockImplementation(async () => {
      calls += 1;
      return calls <= 1
        ? { verdict: "DRIFTED" as const, services: [] }
        : { verdict: "CONVERGED_HEALTHY" as const, services: [{ name: "web", status: "running", health: null, restartCount: 0 }] };
    });
    const planHash = (await recomputePlanHash(deployment.id, revision.id))!;

    const result = await requestDeploymentOperation({ deploymentId: deployment.id, type: "DEPLOY", revisionId: revision.id, planHash, actor: sessionFor(world.adminA) });
    await waitForTerminal((result as { operationId: string }).operationId);

    const op = await prisma.deploymentOperation.findFirstOrThrow({ where: { deploymentId: deployment.id } });
    expect(op.state).toBe("SUCCEEDED");
    const d = await prisma.deployment.findUniqueOrThrow({ where: { id: deployment.id } });
    expect(d.runtimeState).toBe("CONVERGED");
    expect(d.currentReleaseId).not.toBeNull();
  });

  it("stale plan is rejected before any mutation", async () => {
    const world = await seedWorld();
    const { deployment, revision } = await makeManaged(sessionFor(world.adminA));
    const result = await requestDeploymentOperation({
      deploymentId: deployment.id, type: "DEPLOY", revisionId: revision.id, planHash: "stale-hash-0000000000000000", actor: sessionFor(world.adminA)
    });
    expect(result.status).toBe("plan_stale");
    expect(agent.prepareDeployment).not.toHaveBeenCalled();
  });

  it("execution is denied on LEGACY_HTTP nodes", async () => {
    const outer = await seedWorld();
    const { world, deployment, revision } = await makeManaged(sessionFor(outer.adminA));
    await prisma.node.update({ where: { id: world.node1.id }, data: { transportMode: "LEGACY_HTTP" } });
    const planHash = (await recomputePlanHash(deployment.id, revision.id))!;
    const result = await requestDeploymentOperation({ deploymentId: deployment.id, type: "DEPLOY", revisionId: revision.id, planHash, actor: sessionFor(outer.adminA) });
    expect(result.status).toBe("execution_unsupported");
  });

  it("external COMPOSE workload (no Deployment) cannot execute", async () => {
    const world = await seedWorld();
    const suffix = crypto.randomUUID().slice(0, 8);
    await prisma.project.create({
      data: { name: `Ext ${suffix}`, slug: `ext-${suffix}`, source: ProjectSource.COMPOSE, composeProject: `extcp-${suffix}`, nodeId: world.node1.id, isActive: true }
    });
    // No Deployment was created; a deploy request referencing a non-deployment id fails.
    const result = await requestDeploymentOperation({
      deploymentId: "nonexistent-deployment", type: "DEPLOY", revisionId: "nonexistent-revision", planHash: "x".repeat(64), actor: sessionFor(world.adminA)
    });
    expect(result.status).toBe("deployment_not_found");
    expect(agent.prepareDeployment).not.toHaveBeenCalled();
  });

  it("concurrent deploys are locked (deployment_op_in_progress)", async () => {
    const world = await seedWorld();
    const { deployment, revision } = await makeManaged(sessionFor(world.adminA));
    agent.prepareDeployment.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 300));
      return { ok: true, prepared: true, revisionNumber: 1 };
    });
    const planHash = (await recomputePlanHash(deployment.id, revision.id))!;

    const first = await requestDeploymentOperation({ deploymentId: deployment.id, type: "DEPLOY", revisionId: revision.id, planHash, actor: sessionFor(world.adminA) });
    expect(first.status).toBe("created");
    const second = await requestDeploymentOperation({ deploymentId: deployment.id, type: "DEPLOY", revisionId: revision.id, planHash, actor: sessionFor(world.adminA) });
    expect(second.status).toBe("deployment_op_in_progress");
    await waitForTerminal((first as { operationId: string }).operationId);
  });

  it("same revision + rotated secret produces a DIFFERENT release", async () => {
    const outer = await seedWorld();
    const { world, deployment, revision } = await makeManaged(sessionFor(outer.adminA));

    const deploy = async () => {
      const planHash = (await recomputePlanHash(deployment.id, revision.id))!;
      const result = await requestDeploymentOperation({ deploymentId: deployment.id, type: "DEPLOY", revisionId: revision.id, planHash, actor: sessionFor(outer.adminA) });
      expect(result.status).toBe("created");
      await waitForTerminal((result as { operationId: string }).operationId);
    };

    await deploy();
    const releaseA = await prisma.deploymentRelease.findFirstOrThrow({ where: { deploymentId: deployment.id }, orderBy: { createdAt: "asc" } });

    // Rotate the secret (no new revision).
    const secret = await prisma.secret.findFirstOrThrow({ where: { deploymentId: deployment.id, key: "DB_PASSWORD" } });
    await rotateSecret({ deploymentId: deployment.id, secretId: secret.id, value: "secret-value-2", actor: sessionFor(outer.adminA) });

    await deploy();
    const releases = await prisma.deploymentRelease.findMany({ where: { deploymentId: deployment.id }, orderBy: { createdAt: "asc" } });
    expect(releases).toHaveLength(2);
    const releaseB = releases[1];

    expect(releaseB.id).not.toBe(releaseA.id);
    expect(releaseB.revisionId).toBe(releaseA.revisionId); // same revision
    const snapA = await prisma.deploymentReleaseSecret.findFirstOrThrow({ where: { releaseId: releaseA.id, key: "DB_PASSWORD" } });
    const snapB = await prisma.deploymentReleaseSecret.findFirstOrThrow({ where: { releaseId: releaseB.id, key: "DB_PASSWORD" } });
    expect(snapA.versionNumber).toBe(1);
    expect(snapB.versionNumber).toBe(2);
    expect(snapA.secretVersionId).not.toBe(snapB.secretVersionId);
  });

  it("cancellation verifies runtime and marks CANCELLED", async () => {
    const world = await seedWorld();
    const { deployment, revision } = await makeManaged(sessionFor(world.adminA));
    agent.prepareDeployment.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 400));
      return { ok: true, prepared: true, revisionNumber: 1 };
    });
    const planHash = (await recomputePlanHash(deployment.id, revision.id))!;
    const result = await requestDeploymentOperation({ deploymentId: deployment.id, type: "DEPLOY", revisionId: revision.id, planHash, actor: sessionFor(world.adminA) });
    const operationId = (result as { operationId: string }).operationId;

    const cancel = await requestCancellation(operationId, sessionFor(world.adminA));
    expect(cancel.status).toBe("cancelled");
    await waitForTerminal(operationId);
    const op = await prisma.deploymentOperation.findUniqueOrThrow({ where: { id: operationId } });
    expect(op.state).toBe("CANCELLED");
  });

  it("recovery sweep only finalises genuinely-stale operations (never a fresh in-flight one)", async () => {
    const world = await seedWorld();
    // Two separate deployments — the active-operation uniqueness index allows
    // only one ACTIVE operation per deployment.
    const { deployment: freshDep, revision: freshRev } = await makeManaged(sessionFor(world.adminA));
    const { deployment: staleDep, revision: staleRev } = await makeManaged(sessionFor(world.adminA));

    // Fresh REQUESTED op — must be left untouched by the sweep.
    const fresh = await prisma.deploymentOperation.create({
      data: {
        type: "DEPLOY", requestId: crypto.randomUUID(), deploymentId: freshDep.id, revisionId: freshRev.id,
        state: "REQUESTED", requestedAt: new Date()
      }
    });
    // Stale RUNNING op (started 20 min ago) — must be recovered.
    const stale = await prisma.deploymentOperation.create({
      data: {
        type: "DEPLOY", requestId: crypto.randomUUID(), deploymentId: staleDep.id, revisionId: staleRev.id,
        state: "RUNNING", requestedAt: new Date(Date.now() - 25 * 60_000), startedAt: new Date(Date.now() - 20 * 60_000)
      }
    });

    await sweepStaleDeploymentOperations();

    const freshAfter = await prisma.deploymentOperation.findUniqueOrThrow({ where: { id: fresh.id } });
    expect(freshAfter.state).toBe("REQUESTED");

    const staleAfter = await prisma.deploymentOperation.findUniqueOrThrow({ where: { id: stale.id } });
    expect(staleAfter.state).toBe("SUCCEEDED"); // verify mock returns CONVERGED_HEALTHY
    expect((staleAfter.result as { recovered?: boolean }).recovered).toBe(true);
  });

  it("healthcheck not yet determined (PENDING) during grace window converges to DEGRADED", async () => {
    const world = await seedWorld();
    const { deployment, revision } = await makeManaged(sessionFor(world.adminA));
    await prisma.deployment.update({ where: { id: deployment.id }, data: { verifyGraceMs: 10_000 } });
    let calls = 0;
    agent.verifyDeployment.mockImplementation(async () => {
      calls += 1;
      return calls === 1
        ? { verdict: "PENDING" as const, services: [{ name: "web", status: "running", health: "starting", restartCount: 0 }] }
        : { verdict: "CONVERGED_DEGRADED" as const, services: [{ name: "web", status: "running", health: "unhealthy", restartCount: 3 }] };
    });
    const planHash = (await recomputePlanHash(deployment.id, revision.id))!;

    const result = await requestDeploymentOperation({ deploymentId: deployment.id, type: "DEPLOY", revisionId: revision.id, planHash, actor: sessionFor(world.adminA) });
    await waitForTerminal((result as { operationId: string }).operationId);

    const op = await prisma.deploymentOperation.findFirstOrThrow({ where: { deploymentId: deployment.id } });
    expect(op.state).toBe("FAILED");
    expect(op.error).toContain("health verification failed");
    const d = await prisma.deployment.findUniqueOrThrow({ where: { id: deployment.id } });
    expect(d.runtimeState).toBe("DEGRADED");
    expect(d.currentReleaseId).not.toBeNull();
    const release = await prisma.deploymentRelease.findUniqueOrThrow({ where: { id: d.currentReleaseId! } });
    expect(release.healthVerdict).toBe("DEGRADED");
  });

  it("PENDING for the whole grace window → FAILED with unproven-health error + DEGRADED release", async () => {
    const world = await seedWorld();
    const { deployment, revision } = await makeManaged(sessionFor(world.adminA));
    await prisma.deployment.update({ where: { id: deployment.id }, data: { verifyGraceMs: 300 } });
    agent.verifyDeployment.mockResolvedValue({ verdict: "PENDING" as const, services: [{ name: "web", status: "running", health: "starting", restartCount: 0 }] });
    const planHash = (await recomputePlanHash(deployment.id, revision.id))!;

    const result = await requestDeploymentOperation({ deploymentId: deployment.id, type: "DEPLOY", revisionId: revision.id, planHash, actor: sessionFor(world.adminA) });
    await waitForTerminal((result as { operationId: string }).operationId);

    const op = await prisma.deploymentOperation.findFirstOrThrow({ where: { deploymentId: deployment.id } });
    expect(op.state).toBe("FAILED");
    expect(op.error).toContain("did not stabilize");
    const d = await prisma.deployment.findUniqueOrThrow({ where: { id: deployment.id } });
    expect(d.runtimeState).toBe("DEGRADED");
    expect(d.currentReleaseId).not.toBeNull();
  });

  it("stale plan rejected after secret rotation (planHash binds secret versions)", async () => {
    const outer = await seedWorld();
    const { deployment, revision } = await makeManaged(sessionFor(outer.adminA));
    const oldHash = (await recomputePlanHash(deployment.id, revision.id))!;
    const secret = await prisma.secret.findFirstOrThrow({ where: { deploymentId: deployment.id, key: "DB_PASSWORD" } });
    await rotateSecret({ deploymentId: deployment.id, secretId: secret.id, value: "rotated-value", actor: sessionFor(outer.adminA) });

    const result = await requestDeploymentOperation({ deploymentId: deployment.id, type: "DEPLOY", revisionId: revision.id, planHash: oldHash, actor: sessionFor(outer.adminA) });
    expect(result.status).toBe("plan_stale");
    expect(agent.prepareDeployment).not.toHaveBeenCalled();
  });

  it("getRollbackTarget returns null when no healthy release exists yet", async () => {
    const world = await seedWorld();
    const { deployment } = await makeManaged(sessionFor(world.adminA));
    expect(await getRollbackTarget(deployment.id)).toBeNull();
  });

  it("rollback targets the previous healthy revision and creates a NEW release with the latest secret version", async () => {
    const outer = await seedWorld();
    const { deployment, revision } = await makeManaged(sessionFor(outer.adminA));

    const deploy = async (revId: string, verdict: string) => {
      agent.verifyDeployment.mockResolvedValue({
        verdict: verdict as "CONVERGED_HEALTHY" | "CONVERGED_DEGRADED",
        services: [{ name: "web", status: "running", health: verdict === "CONVERGED_DEGRADED" ? "unhealthy" : null, restartCount: verdict === "CONVERGED_DEGRADED" ? 3 : 0 }]
      });
      const planHash = (await recomputePlanHash(deployment.id, revId))!;
      const result = await requestDeploymentOperation({ deploymentId: deployment.id, type: "DEPLOY", revisionId: revId, planHash, actor: sessionFor(outer.adminA) });
      expect(result.status).toBe("created");
      await waitForTerminal((result as { operationId: string }).operationId);
    };

    // Healthy deploy of revision 1 (secret v1).
    await deploy(revision.id, "CONVERGED_HEALTHY");
    const secret = await prisma.secret.findFirstOrThrow({ where: { deploymentId: deployment.id, key: "DB_PASSWORD" } });

    // Rotate to v2 + healthy redeploy → release B (the previous healthy release).
    await rotateSecret({ deploymentId: deployment.id, secretId: secret.id, value: "secret-value-2", actor: sessionFor(outer.adminA) });
    await deploy(revision.id, "CONVERGED_HEALTHY");
    const releasesAfterB = await prisma.deploymentRelease.findMany({ where: { deploymentId: deployment.id }, orderBy: { createdAt: "asc" } });
    const releaseB = releasesAfterB[1];

    // Degraded revision 2 → degraded release C.
    const rev2 = await prisma.deploymentRevision.create({
      data: {
        deploymentId: deployment.id, revisionNumber: 2, source: DeploymentSource.HOSTPANEL,
        composeSource: "services:\n  web:\n    image: nginx:stable\n    environment:\n      DB: ${DB_PASSWORD}\n",
        composeCanonical: "services:\n  web:\n    image: nginx:stable\n    environment:\n      DB: __HOSTPANEL_SECRET_DB_PASSWORD__\n",
        environmentSnapshot: {}, secretReferences: ["DB_PASSWORD"],
        contentSha256: crypto.randomUUID(), analyzerVersion: "1"
      }
    });
    await deploy(rev2.id, "CONVERGED_DEGRADED");
    const depMid = await prisma.deployment.findUniqueOrThrow({ where: { id: deployment.id } });
    expect(depMid.runtimeState).toBe("DEGRADED");
    expect(depMid.lastHealthyReleaseId).toBe(releaseB.id);

    // Target resolves to the previous healthy release's revision.
    const target = await getRollbackTarget(deployment.id);
    expect(target?.revisionId).toBe(revision.id);
    expect(target?.revisionNumber).toBe(1);
    expect(target?.fromReleaseId).toBe(releaseB.id);

    // Rotate to v3 (latest) WITHOUT deploying — rollback must use v3, not v2.
    await rotateSecret({ deploymentId: deployment.id, secretId: secret.id, value: "secret-value-3", actor: sessionFor(outer.adminA) });

    agent.verifyDeployment.mockResolvedValue({ verdict: "CONVERGED_HEALTHY" as const, services: [{ name: "web", status: "running", health: null, restartCount: 0 }] });
    const planHash = (await recomputePlanHash(deployment.id, target!.revisionId))!;
    const rb = await requestDeploymentOperation({ deploymentId: deployment.id, type: "ROLLBACK", revisionId: target!.revisionId, planHash, actor: sessionFor(outer.adminA) });
    expect(rb.status).toBe("created");
    await waitForTerminal((rb as { operationId: string }).operationId);

    const releaseD = (await prisma.deploymentRelease.findMany({ where: { deploymentId: deployment.id }, orderBy: { createdAt: "asc" } })).at(-1)!;
    expect(releaseD.id).not.toBe(releaseB.id); // new release, NOT the old one reactivated
    expect(releaseD.revisionId).toBe(releaseB.revisionId); // same configuration
    expect(releaseD.healthVerdict).toBe("HEALTHY");
    const snapD = await prisma.deploymentReleaseSecret.findFirstOrThrow({ where: { releaseId: releaseD.id, key: "DB_PASSWORD" } });
    expect(snapD.versionNumber).toBe(3); // LATEST secret version, not the historical v2
    const opD = await prisma.deploymentOperation.findUniqueOrThrow({ where: { id: releaseD.operationId! } });
    expect(opD.type).toBe("ROLLBACK");
    const depAfter = await prisma.deployment.findUniqueOrThrow({ where: { id: deployment.id } });
    expect(depAfter.runtimeState).toBe("CONVERGED");
    expect(depAfter.currentReleaseId).toBe(releaseD.id);
    expect(depAfter.lastHealthyReleaseId).toBe(releaseD.id);
  });

  it("release image snapshot takes ACTUAL runtime identity from verification", async () => {
    const world = await seedWorld();
    const { deployment, revision } = await makeManaged(sessionFor(world.adminA));
    agent.verifyDeployment.mockResolvedValue({
      verdict: "CONVERGED_HEALTHY" as const,
      services: [{ name: "web", status: "running", health: null, restartCount: 0, imageId: "sha256:runtime-image-id", repoDigest: "nginx@sha256:runtime-digest", imageRef: "nginx:stable" }]
    });
    const planHash = (await recomputePlanHash(deployment.id, revision.id))!;
    const result = await requestDeploymentOperation({ deploymentId: deployment.id, type: "DEPLOY", revisionId: revision.id, planHash, actor: sessionFor(world.adminA) });
    await waitForTerminal((result as { operationId: string }).operationId);

    const d = await prisma.deployment.findUniqueOrThrow({ where: { id: deployment.id } });
    const release = await prisma.deploymentRelease.findUniqueOrThrow({ where: { id: d.currentReleaseId! }, include: { images: true } });
    expect(release.images).toHaveLength(1);
    expect(release.images[0].imageId).toBe("sha256:runtime-image-id");
    expect(release.images[0].repoDigest).toBe("nginx@sha256:runtime-digest");
    expect(release.images[0].imageRef).toBe("nginx:stable");
  });

  it("removes a stale adopted standalone container (no compose labels) before first apply, never a compose-owned one", async () => {
    const throwaway = await seedWorld();
    const { world, deployment, revision } = await makeManaged(sessionFor(throwaway.adminA));
    const nodeId = world.node1.id;

    // Link a standalone-adopted container (no compose ownership labels) to the
    // project, plus a compose-owned container that must be left alone.
    await prisma.container.create({
      data: {
        nodeId,
        projectId: deployment.projectId,
        dockerContainerId: "adopted-standalone-000",
        dockerName: "adopted-standalone",
        image: "nginx:1.27-alpine",
        lastKnownStatus: "running",
        isActive: true
      }
    });
    await prisma.container.create({
      data: {
        nodeId,
        projectId: deployment.projectId,
        dockerContainerId: "compose-owned-000",
        dockerName: "compose-owned",
        image: "nginx:1.27-alpine",
        lastKnownStatus: "running",
        isActive: true
      }
    });

    agent.inspectContainerFull.mockImplementation(async (_node: unknown, id: string) => {
      if (id === "compose-owned-000") {
        return { nodeOnline: true, inspect: { Config: { Labels: { "com.docker.compose.project": "ecp" } } } as never };
      }
      return { nodeOnline: true, inspect: { Config: { Labels: {} } } as never };
    });

    const planHash = (await recomputePlanHash(deployment.id, revision.id))!;
    const result = await requestDeploymentOperation({ deploymentId: deployment.id, type: "DEPLOY", revisionId: revision.id, planHash, actor: sessionFor(world.adminA) });
    await waitForTerminal((result as { operationId: string }).operationId);

    expect(agent.removeContainer).toHaveBeenCalledWith(expect.objectContaining({ id: nodeId }), "adopted-standalone-000");
    expect(agent.removeContainer).not.toHaveBeenCalledWith(expect.objectContaining({ id: nodeId }), "compose-owned-000");
    expect(agent.applyDeployment).toHaveBeenCalled();
  });

  it("does NOT remove containers once a current release already exists", async () => {
    const world = await seedWorld();
    const { deployment, revision } = await makeManaged(sessionFor(world.adminA));
    // Simulate a prior successful release so currentReleaseId is non-null.
    await prisma.deployment.update({ where: { id: deployment.id }, data: { currentReleaseId: "unused-release-id" } });
    await prisma.container.create({
      data: {
        nodeId: world.node1.id,
        projectId: deployment.projectId,
        dockerContainerId: "adopted-standalone-000",
        dockerName: "adopted-standalone",
        image: "nginx:1.27-alpine",
        lastKnownStatus: "running",
        isActive: true
      }
    });
    const planHash = (await recomputePlanHash(deployment.id, revision.id))!;
    const result = await requestDeploymentOperation({ deploymentId: deployment.id, type: "DEPLOY", revisionId: revision.id, planHash, actor: sessionFor(world.adminA) });
    await waitForTerminal((result as { operationId: string }).operationId);
    expect(agent.removeContainer).not.toHaveBeenCalled();
  });
});
