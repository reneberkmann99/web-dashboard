import { beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { DeploymentSource, ProjectSource } from "@prisma/client";
import { prisma } from "./helpers/db";
import { resetDatabase } from "./setup";
import { seedWorld, sessionFor } from "./helpers/fixtures";
import {
  createSecret,
  rotateSecret,
  setSecretActive,
  listSecrets
} from "@/server/services/deployment-secrets";

beforeAll(async () => {
  resetDatabase();
});

async function createDeploymentFixture(nodeId: string) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const project = await prisma.project.create({
    data: {
      name: `Managed ${suffix}`,
      slug: `managed-${suffix}`,
      source: ProjectSource.COMPOSE,
      composeProject: `cp-${suffix}`,
      nodeId,
      isActive: true
    }
  });
  return prisma.deployment.create({
    data: { projectId: project.id, source: DeploymentSource.HOSTPANEL, composeProjectName: project.composeProject ?? `cp-${suffix}` }
  });
}

describe("deployment secrets", () => {
  it("create returns metadata only — never the value", async () => {
    const world = await seedWorld();
    const deployment = await createDeploymentFixture(world.node1.id);
    const secret = await createSecret({
      deploymentId: deployment.id,
      key: "DB_PASSWORD",
      value: "hunter2-secret-value",
      actor: sessionFor(world.adminA)
    });
    expect(secret.key).toBe("DB_PASSWORD");
    expect(secret.latestVersion?.versionNumber).toBe(1);
    expect(JSON.stringify(secret)).not.toContain("hunter2-secret-value");
    expect(secret).not.toHaveProperty("ciphertext");
    expect(secret).not.toHaveProperty("value");
  });

  it("rotate appends versions; latest is the highest version number", async () => {
    const world = await seedWorld();
    const deployment = await createDeploymentFixture(world.node1.id);
    const created = await createSecret({
      deploymentId: deployment.id, key: "API_KEY", value: "v1", actor: sessionFor(world.adminA)
    });
    await rotateSecret({ deploymentId: deployment.id, secretId: created.id, value: "v2", actor: sessionFor(world.adminA) });
    await rotateSecret({ deploymentId: deployment.id, secretId: created.id, value: "v3", actor: sessionFor(world.adminA) });

    const list = await listSecrets(deployment.id);
    const secret = list.find((s) => s.id === created.id)!;
    expect(secret.latestVersion?.versionNumber).toBe(3);

    const versions = await prisma.secretVersion.findMany({
      where: { secretId: created.id },
      orderBy: { versionNumber: "asc" }
    });
    expect(versions.map((v) => v.versionNumber)).toEqual([1, 2, 3]);
  });

  it("disable soft-deactivates and retains version history", async () => {
    const world = await seedWorld();
    const deployment = await createDeploymentFixture(world.node1.id);
    const created = await createSecret({
      deploymentId: deployment.id, key: "TOKEN", value: "xyz", actor: sessionFor(world.adminA)
    });
    const disabled = await setSecretActive({
      deploymentId: deployment.id, secretId: created.id, isActive: false, actor: sessionFor(world.adminA)
    });
    expect(disabled.isActive).toBe(false);
    expect(await prisma.secretVersion.count({ where: { secretId: created.id } })).toBe(1);
  });

  it("plaintext never appears in audit records", async () => {
    const world = await seedWorld();
    const deployment = await createDeploymentFixture(world.node1.id);
    const VALUE = "super-secret-audit-probe-value";
    await createSecret({ deploymentId: deployment.id, key: "DB_PASSWORD", value: VALUE, actor: sessionFor(world.adminA) });
    await rotateSecret({ deploymentId: deployment.id, secretId: (await listSecrets(deployment.id))[0].id, value: "rotated-probe-value", actor: sessionFor(world.adminA) });

    const audits = await prisma.auditLog.findMany({
      where: { targetType: "SECRET" }
    });
    expect(audits.length).toBeGreaterThan(0);
    for (const a of audits) {
      expect(JSON.stringify(a)).not.toContain(VALUE);
      expect(JSON.stringify(a)).not.toContain("rotated-probe-value");
    }
  });

  it("secret values are encrypted at rest (ciphertext ≠ plaintext)", async () => {
    const world = await seedWorld();
    const deployment = await createDeploymentFixture(world.node1.id);
    const created = await createSecret({
      deploymentId: deployment.id, key: "SMTP_PASSWORD", value: "plaintext-probe", actor: sessionFor(world.adminA)
    });
    const version = await prisma.secretVersion.findFirstOrThrow({ where: { secretId: created.id } });
    expect(version.ciphertext).not.toContain("plaintext-probe");
    expect(version.ciphertext.split(":")).toHaveLength(3);
  });

  it("rotate/disable are scoped to the deployment (cross-deployment returns NOT_FOUND)", async () => {
    const world = await seedWorld();
    const d1 = await createDeploymentFixture(world.node1.id);
    const d2 = await createDeploymentFixture(world.node1.id);
    const secret = await createSecret({ deploymentId: d1.id, key: "K", value: "v", actor: sessionFor(world.adminA) });

    await expect(
      rotateSecret({ deploymentId: d2.id, secretId: secret.id, value: "x", actor: sessionFor(world.adminA) })
    ).rejects.toThrow(/NOT_FOUND/);
  });
});
