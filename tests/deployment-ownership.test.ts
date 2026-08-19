import { beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { DeploymentSource, ProjectSource } from "@prisma/client";
import { prisma } from "./helpers/db";
import { resetDatabase } from "./setup";
import { seedWorld } from "./helpers/fixtures";
import { getDeployment } from "@/server/services/deployments";

/**
 * Ownership model: the presence of a Deployment relation is the sole signal of
 * managed lifecycle. Existing MANUAL and EXTERNAL_COMPOSE workloads must never
 * gain a Deployment automatically (no migration backfill).
 */
beforeAll(async () => {
  resetDatabase();
});

describe("deployment ownership model", () => {
  it("migration creates no Deployment backfill", async () => {
    await seedWorld();
    expect(await prisma.deployment.count()).toBe(0);
  });

  it("existing MANUAL workloads remain unmanaged", async () => {
    const world = await seedWorld();
    expect(world.projectA.source).toBe("MANUAL");
    const deployment = await prisma.deployment.findUnique({ where: { projectId: world.projectA.id } });
    expect(deployment).toBeNull();
  });

  it("existing EXTERNAL_COMPOSE workloads remain unmanaged", async () => {
    const world = await seedWorld();
    const composeProject = `external-${crypto.randomUUID().slice(0, 8)}`;
    const external = await prisma.project.create({
      data: {
        name: "External Compose",
        slug: `external-${crypto.randomUUID().slice(0, 8)}`,
        source: ProjectSource.COMPOSE,
        composeProject,
        nodeId: world.node1.id,
        isActive: true
      }
    });
    expect(external.source).toBe("COMPOSE");
    expect(await prisma.deployment.findUnique({ where: { projectId: external.id } })).toBeNull();
  });

  it("a Project with a Deployment derives MANAGED_COMPOSE", async () => {
    const world = await seedWorld();
    const project = await prisma.project.create({
      data: {
        name: "Managed Stack",
        slug: `managed-${crypto.randomUUID().slice(0, 8)}`,
        source: ProjectSource.COMPOSE,
        composeProject: `managed-${crypto.randomUUID().slice(0, 8)}`,
        nodeId: world.node1.id,
        isActive: true
      }
    });
    const deployment = await prisma.deployment.create({
      data: {
        projectId: project.id,
        source: DeploymentSource.HOSTPANEL,
        composeProjectName: project.composeProject ?? "managed"
      }
    });

    const view = await getDeployment(deployment.id);
    expect(view).not.toBeNull();
    expect(view?.ownershipMode).toBe("MANAGED_COMPOSE");
    expect(view?.project.source).toBe("COMPOSE");
    expect(view?.currentReleaseId).toBeNull();
    expect(view?.lastHealthyReleaseId).toBeNull();
  });

  it("Deployment → Project is RESTRICT (cannot hard-delete a managed project)", async () => {
    const world = await seedWorld();
    const project = await prisma.project.create({
      data: {
        name: "Locked",
        slug: `locked-${crypto.randomUUID().slice(0, 8)}`,
        source: ProjectSource.COMPOSE,
        composeProject: `locked-${crypto.randomUUID().slice(0, 8)}`,
        nodeId: world.node1.id,
        isActive: true
      }
    });
    await prisma.deployment.create({
      data: { projectId: project.id, source: DeploymentSource.HOSTPANEL, composeProjectName: project.composeProject ?? "locked" }
    });

    await expect(prisma.project.delete({ where: { id: project.id } })).rejects.toThrow();
  });
});
