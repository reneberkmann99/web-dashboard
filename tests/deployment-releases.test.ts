import { beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { DeploymentSource, ProjectSource } from "@prisma/client";
import { prisma } from "./helpers/db";
import { resetDatabase } from "./setup";
import { seedWorld, sessionFor } from "./helpers/fixtures";
import { createSecret, listSecrets } from "@/server/services/deployment-secrets";
import { listDeploymentReleases, getDeploymentReleaseDetail } from "@/server/services/deployment-releases";
import { getAdminWorkloadDeploymentStatus } from "@/server/services/deployments";

beforeAll(() => resetDatabase());

const CANONICAL = "services:\n  web:\n    image: nginx:stable\n    environment:\n      DB: __HOSTPANEL_SECRET_DB_PASSWORD__\n";

async function makeFixture() {
  const world = await seedWorld();
  const actor = sessionFor(world.adminA);
  const suffix = crypto.randomUUID().slice(0, 8);

  const project = await prisma.project.create({
    data: { name: `Rel ${suffix}`, slug: `rel-${suffix}`, source: ProjectSource.COMPOSE, composeProject: `rel-${suffix}`, nodeId: world.node1.id, isActive: true }
  });
  const deployment = await prisma.deployment.create({
    data: { projectId: project.id, source: DeploymentSource.HOSTPANEL, composeProjectName: `rel-${suffix}` }
  });
  const rev1 = await prisma.deploymentRevision.create({
    data: {
      deploymentId: deployment.id, revisionNumber: 1, source: DeploymentSource.HOSTPANEL,
      composeSource: CANONICAL, composeCanonical: CANONICAL, environmentSnapshot: {},
      secretReferences: ["DB_PASSWORD"], contentSha256: crypto.randomUUID(), analyzerVersion: "1"
    }
  });
  const rev2 = await prisma.deploymentRevision.create({
    data: {
      deploymentId: deployment.id, revisionNumber: 2, source: DeploymentSource.HOSTPANEL,
      composeSource: CANONICAL, composeCanonical: CANONICAL, environmentSnapshot: {},
      secretReferences: ["DB_PASSWORD"], contentSha256: crypto.randomUUID(), analyzerVersion: "1"
    }
  });
  await createSecret({ deploymentId: deployment.id, key: "DB_PASSWORD", value: "plaintext-marker-xyz", actor });
  return { world, project, deployment, rev1, rev2 };
}

type ReleaseOpts = {
  health: "HEALTHY" | "DEGRADED";
  opType?: "DEPLOY" | "ROLLBACK";
  actorEmail?: string;
  secretVersionNumber: number;
  verifyVerdict?: string;
  runtimeConverged?: boolean;
};

async function makeRelease(
  deploymentId: string,
  revisionId: string,
  opts: ReleaseOpts
) {
  const op = await prisma.deploymentOperation.create({
    data: {
      type: opts.opType ?? "DEPLOY",
      requestId: crypto.randomUUID(),
      deploymentId,
      revisionId,
      state: opts.health === "HEALTHY" ? "SUCCEEDED" : "FAILED",
      actorEmail: opts.actorEmail ?? null,
      error: opts.health === "HEALTHY" ? null : "health verification failed",
      finishedAt: new Date(),
      result: {
        verify: { verdict: opts.verifyVerdict ?? (opts.health === "HEALTHY" ? "CONVERGED_HEALTHY" : "CONVERGED_DEGRADED") },
        runtimeConverged: opts.runtimeConverged ?? true,
        health: opts.health
      }
    }
  });
  const release = await prisma.deploymentRelease.create({
    data: {
      deploymentId,
      revisionId,
      operationId: op.id,
      healthVerdict: opts.health,
      appliedAt: new Date(),
      verifiedAt: new Date()
    }
  });
  await prisma.deploymentReleaseSecret.create({
    data: { releaseId: release.id, secretId: crypto.randomUUID(), key: "DB_PASSWORD", versionNumber: opts.secretVersionNumber, secretVersionId: crypto.randomUUID() }
  });
  await prisma.deploymentReleaseImage.create({
    data: { releaseId: release.id, serviceName: "web", imageRef: "nginx:stable", imageId: "sha256:imgid", repoDigest: "nginx@sha256:digest" }
  });
  return release;
}

describe("deployment releases list + detail (6C)", () => {
  it("lists releases newest-first with stable display numbers, markers and no secret material", async () => {
    const { deployment, rev1, rev2 } = await makeFixture();
    const r1 = await makeRelease(deployment.id, rev1.id, { health: "HEALTHY", secretVersionNumber: 1, actorEmail: "a@x.ee" });
    const r2 = await makeRelease(deployment.id, rev2.id, { health: "DEGRADED", secretVersionNumber: 2 });
    const r3 = await makeRelease(deployment.id, rev2.id, { health: "HEALTHY", opType: "ROLLBACK", secretVersionNumber: 2 });

    await prisma.deployment.update({
      where: { id: deployment.id },
      data: { currentReleaseId: r3.id, lastHealthyReleaseId: r3.id, runtimeState: "CONVERGED" }
    });

    const list = await listDeploymentReleases(deployment.id)!;
    expect(list).not.toBeNull();
    expect(list!.total).toBe(3);
    expect(list!.data.map((r) => r.displayNumber)).toEqual([3, 2, 1]); // newest first
    const first = list!.data[0];
    expect(first.id).toBe(r3.id);
    expect(first.isCurrent).toBe(true);
    expect(first.isLastHealthy).toBe(true);
    expect(first.operationType).toBe("ROLLBACK");
    expect(first.sameRevisionAsPrevious).toBe(true); // r3 reused rev2
    expect(list!.data[1].sameRevisionAsPrevious).toBe(false);
    expect(list!.data[2].isLastHealthy).toBe(false);
    expect(first.images).toHaveLength(1);
    expect(first.secrets).toEqual([{ key: "DB_PASSWORD", versionNumber: 2 }]);

    const serialized = JSON.stringify(list);
    expect(serialized).not.toContain("plaintext-marker-xyz");
    expect(serialized).not.toContain("ciphertext");
  });

  it("marks current vs last healthy distinctly after a degraded release", async () => {
    const { deployment, rev1, rev2 } = await makeFixture();
    const r1 = await makeRelease(deployment.id, rev1.id, { health: "HEALTHY", secretVersionNumber: 1 });
    const r2 = await makeRelease(deployment.id, rev2.id, { health: "DEGRADED", secretVersionNumber: 1 });
    await prisma.deployment.update({
      where: { id: deployment.id },
      data: { currentReleaseId: r2.id, lastHealthyReleaseId: r1.id, runtimeState: "DEGRADED" }
    });

    const list = await listDeploymentReleases(deployment.id)!;
    const current = list!.data.find((r) => r.id === r2.id)!;
    const lastHealthy = list!.data.find((r) => r.id === r1.id)!;
    expect(current.isCurrent).toBe(true);
    expect(current.isLastHealthy).toBe(false);
    expect(current.healthVerdict).toBe("DEGRADED");
    expect(current.failureReason).toContain("health verification failed");
    expect(lastHealthy.isCurrent).toBe(false);
    expect(lastHealthy.isLastHealthy).toBe(true);
    expect(list!.runtimeState).toBe("DEGRADED");
  });

  it("paginates with limit/offset", async () => {
    const { deployment, rev1 } = await makeFixture();
    for (let i = 0; i < 5; i++) {
      await makeRelease(deployment.id, rev1.id, { health: "HEALTHY", secretVersionNumber: 1 });
    }
    const page1 = await listDeploymentReleases(deployment.id, { limit: 2, offset: 0 })!;
    expect(page1!.data).toHaveLength(2);
    expect(page1!.data[0].displayNumber).toBe(5);
    const page3 = await listDeploymentReleases(deployment.id, { limit: 2, offset: 4 })!;
    expect(page3!.data).toHaveLength(1);
    expect(page3!.data[0].displayNumber).toBe(1);
    expect(page1!.total).toBe(5);
  });

  it("release detail detects secret rotation (same revision, changed secret version)", async () => {
    const { deployment, rev2 } = await makeFixture();
    const rA = await makeRelease(deployment.id, rev2.id, { health: "HEALTHY", secretVersionNumber: 1, verifyVerdict: "CONVERGED_HEALTHY" });
    const rB = await makeRelease(deployment.id, rev2.id, { health: "HEALTHY", secretVersionNumber: 2, verifyVerdict: "CONVERGED_HEALTHY" });
    await prisma.deployment.update({ where: { id: deployment.id }, data: { currentReleaseId: rB.id, lastHealthyReleaseId: rB.id } });

    const detail = await getDeploymentReleaseDetail(deployment.id, rB.id);
    expect(detail).not.toBeNull();
    expect(detail!.sameRevisionAsPrevious).toBe(true);
    expect(detail!.rotatedSecretKeys).toEqual(["DB_PASSWORD"]);
    expect(detail!.previousRelease?.id).toBe(rA.id);
    expect(detail!.operationResult.verifyVerdict).toBe("CONVERGED_HEALTHY");
    expect(detail!.operationResult.runtimeConverged).toBe(true);
    expect(JSON.stringify(detail)).not.toContain("plaintext-marker-xyz");
  });

  it("returns null for unknown deployment/release", async () => {
    expect(await listDeploymentReleases("nonexistent")).toBeNull();
    const { deployment } = await makeFixture();
    expect(await getDeploymentReleaseDetail(deployment.id, "nonexistent")).toBeNull();
  });

  it("admin workload deployment status: managed summary with display numbers", async () => {
    const { deployment, project, rev1 } = await makeFixture();
    const r1 = await makeRelease(deployment.id, rev1.id, { health: "HEALTHY", secretVersionNumber: 1, actorEmail: "admin@x.ee" });
    await prisma.deployment.update({ where: { id: deployment.id }, data: { currentReleaseId: r1.id, lastHealthyReleaseId: r1.id } });

    const status = await getAdminWorkloadDeploymentStatus(project.id);
    expect(status?.managed).toBe(true);
    expect(status?.runtimeState).toBe("UNKNOWN"); // default enum
    expect(status?.currentRelease?.displayNumber).toBe(1);
    expect(status?.currentRelease?.actorEmail).toBe("admin@x.ee");
    expect(status?.lastHealthyRelease?.displayNumber).toBe(1);

    // Non-managed (plain COMPOSE) workload → managed:false
    const suffix = crypto.randomUUID().slice(0, 8);
    const plain = await prisma.project.create({
      data: { name: `Plain ${suffix}`, slug: `plain-${suffix}`, source: ProjectSource.COMPOSE, composeProject: `plain-${suffix}`, nodeId: (await seedWorld()).node1.id, isActive: true }
    });
    const plainStatus = await getAdminWorkloadDeploymentStatus(plain.id);
    expect(plainStatus?.managed).toBe(false);
  });

  it("secret list reports service usage from the latest revision canonical (no plaintext)", async () => {
    const { deployment } = await makeFixture();
    const secrets = await listSecrets(deployment.id);
    expect(secrets).toHaveLength(1);
    expect(secrets[0].usedByServices).toBe(1); // web service references DB_PASSWORD
    expect(secrets[0].latestVersion?.versionNumber).toBe(1);
    expect(JSON.stringify(secrets)).not.toContain("plaintext-marker-xyz");
  });
});
