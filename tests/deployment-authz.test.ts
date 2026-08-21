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
  it("capability matrix: CLIENT_ADMIN may author/deploy; CLIENT_OPERATOR is runtime-only; viewer is read-only", () => {
    const admin = capabilitiesForRole(Role.ADMIN);
    expect(admin).toContain("deployment.view");
    expect(admin).toContain("deployment.manage");
    expect(admin).toContain("deployment.deploy");
    expect(admin).toContain("workload.adopt");

    // Configuration authoring roles.
    for (const role of [Role.CLIENT_ADMIN, Role.CLIENT]) {
      const caps = capabilitiesForRole(role);
      expect(caps).toContain("deployment.view");
      expect(caps).toContain("deployment.manage");
      expect(caps).toContain("deployment.deploy");
      expect(caps).toContain("project.create");
      expect(caps).toContain("workload.edit");
      expect(caps).toContain("workload.deploy");
      expect(caps).toContain("secrets.manage");
    }

    // Operator: sees everything it is granted and may act on the RUNTIME, but
    // may never change configuration, deploy, or manage secrets.
    const operator = capabilitiesForRole(Role.CLIENT_OPERATOR);
    expect(operator).toContain("workload.view");
    expect(operator).toContain("deployment.view");
    expect(operator).toContain("container.start");
    expect(operator).toContain("container.stop");
    expect(operator).toContain("container.restart");
    expect(operator).toContain("container.view_logs");
    expect(operator).not.toContain("workload.edit");
    expect(operator).not.toContain("workload.deploy");
    expect(operator).not.toContain("workload.create");
    expect(operator).not.toContain("workload.delete");
    expect(operator).not.toContain("secrets.manage");
    expect(operator).not.toContain("deployment.manage");
    expect(operator).not.toContain("deployment.deploy");
    expect(operator).not.toContain("container.delete");

    // Viewer remains strictly read-only.
    const viewer = capabilitiesForRole(Role.CLIENT_VIEWER);
    expect(viewer).toContain("deployment.view");
    expect(viewer).toContain("workload.view");
    expect(viewer).not.toContain("deployment.manage");
    expect(viewer).not.toContain("deployment.deploy");
    expect(viewer).not.toContain("project.create");
    expect(viewer).not.toContain("container.start");
    expect(viewer).not.toContain("container.stop");
    expect(viewer).not.toContain("container.restart");
    expect(viewer).not.toContain("secrets.manage");
  });

  it("no client role can adopt Docker resources or administer nodes/platform", () => {
    for (const role of [Role.CLIENT_ADMIN, Role.CLIENT_OPERATOR, Role.CLIENT_VIEWER, Role.CLIENT]) {
      const caps = capabilitiesForRole(role);
      expect(caps).not.toContain("workload.adopt");
      expect(caps).not.toContain("node.manage");
      expect(caps).not.toContain("platform.admin");
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

  it("owning-client view returns full status metadata including deploymentId for self-service (still no sensitive fields)", async () => {
    const world = await seedWorld();
    const { project } = await managedWorkloadFor(world.clientA.id, world.node1.id);

    const status = await getClientDeploymentStatus(sessionFor(world.clientAOperator), project.id);
    expect(status).not.toBeNull();
    expect(status?.managed).toBe(true);
    expect(status?.isOwner).toBe(true);
    expect(status?.deploymentId).not.toBeNull();
    // No sensitive fields leak: only status metadata (never compose source, secrets, findings).
    expect(Object.keys(status!).sort()).toEqual(
      ["activeOperation", "createdAt", "currentReleaseId", "deploymentId", "isOwner", "lastHealthyReleaseId", "managed", "runtimeState"].sort()
    );
  });

  it("grant-recipient (non-owning) client view withholds deploymentId", async () => {
    const world = await seedWorld();
    const { project, deployment } = await managedWorkloadFor(world.clientA.id, world.node1.id);
    await prisma.accessGrant.create({
      data: { clientAccountId: world.clientB.id, projectId: project.id, nodeId: world.node1.id, allowedActions: ["start", "stop", "restart"] }
    });
    void deployment;

    const status = await getClientDeploymentStatus(sessionFor(world.clientBOperator), project.id);
    expect(status?.managed).toBe(true);
    expect(status?.isOwner).toBe(false);
    expect(status?.deploymentId).toBeNull();
    expect(status?.activeOperation).toBeNull();
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
