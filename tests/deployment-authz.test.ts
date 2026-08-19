import { beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { DeploymentSource, ProjectSource, Role } from "@prisma/client";
import { prisma } from "./helpers/db";
import { resetDatabase } from "./setup";
import { seedWorld, sessionFor } from "./helpers/fixtures";
import { capabilitiesForRole } from "@/server/auth/policy";
import { getClientDeploymentStatus } from "@/server/services/deployments";

beforeAll(async () => {
  resetDatabase();
});

describe("deployment authorization", () => {
  it("capability matrix: client roles get deployment.view but never manage/deploy", () => {
    const admin = capabilitiesForRole(Role.ADMIN);
    expect(admin).toContain("deployment.view");
    expect(admin).toContain("deployment.manage");
    expect(admin).toContain("deployment.deploy");

    for (const role of [Role.CLIENT_ADMIN, Role.CLIENT_OPERATOR, Role.CLIENT_VIEWER, Role.CLIENT]) {
      const caps = capabilitiesForRole(role);
      expect(caps).toContain("deployment.view");
      expect(caps).not.toContain("deployment.manage");
      expect(caps).not.toContain("deployment.deploy");
    }
  });

  async function managedWorkloadFor(clientId: string, nodeId: string) {
    const suffix = crypto.randomUUID().slice(0, 8);
    const project = await prisma.project.create({
      data: {
        name: `Managed ${suffix}`,
        slug: `m-${suffix}`,
        source: ProjectSource.COMPOSE,
        composeProject: `mcp-${suffix}`,
        clientAccountId: clientId,
        nodeId,
        isActive: true
      }
    });
    const deployment = await prisma.deployment.create({
      data: { projectId: project.id, source: DeploymentSource.HOSTPANEL, composeProjectName: project.composeProject ?? `mcp-${suffix}` }
    });
    return { project, deployment };
  }

  it("grant-scoped client view returns status metadata only", async () => {
    const world = await seedWorld();
    const { project } = await managedWorkloadFor(world.clientA.id, world.node1.id);

    const status = await getClientDeploymentStatus(sessionFor(world.clientAOperator), project.id);
    expect(status).not.toBeNull();
    expect(status?.managed).toBe(true);
    // No sensitive fields leak: only status metadata.
    expect(Object.keys(status!).sort()).toEqual(
      ["createdAt", "currentReleaseId", "lastHealthyReleaseId", "managed", "runtimeState"].sort()
    );
  });

  it("cross-tenant: a different client cannot see the managed workload", async () => {
    const world = await seedWorld();
    const { project } = await managedWorkloadFor(world.clientA.id, world.node1.id);

    // client B operator has no grant and does not own the project.
    expect(await getClientDeploymentStatus(sessionFor(world.clientBOperator), project.id)).toBeNull();
  });

  it("client without a grant cannot see an internal managed workload", async () => {
    const world = await seedWorld();
    const suffix = crypto.randomUUID().slice(0, 8);
    const project = await prisma.project.create({
      data: {
        name: `Internal ${suffix}`,
        slug: `i-${suffix}`,
        source: ProjectSource.COMPOSE,
        composeProject: `icp-${suffix}`,
        clientAccountId: null,
        nodeId: world.node1.id,
        isActive: true
      }
    });
    await prisma.deployment.create({
      data: { projectId: project.id, source: DeploymentSource.HOSTPANEL, composeProjectName: project.composeProject ?? `icp-${suffix}` }
    });

    // No grant exists; client A cannot see it even though they are a valid client.
    expect(await getClientDeploymentStatus(sessionFor(world.clientAOperator), project.id)).toBeNull();
  });
});
