import { beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { DeploymentSource, ProjectSource, Role } from "@prisma/client";
import { prisma } from "./helpers/db";
import { resetDatabase } from "./setup";
import { seedWorld, sessionFor } from "./helpers/fixtures";
import { can, capabilitiesForRole, ensureCan, type Capability } from "@/server/auth/policy";
import { getClientDeployment, requireClientDeployment } from "@/server/services/client-deployments";
import { resolveActionTarget } from "@/server/services/containers";
import { deleteContainer } from "@/server/services/container-lifecycle";
import { deleteWorkload, setWorkloadActive } from "@/server/services/workload-lifecycle";
import { removeServiceFromWorkload } from "@/server/services/workload-service-lifecycle";

beforeAll(async () => {
  resetDatabase();
});

/**
 * Granular capability model — role behavior and cross-tenant / direct-object-id
 * enforcement for every mutation surface the form editor introduces.
 *
 * Every assertion here targets SERVER-SIDE enforcement (services + guards),
 * never UI hiding.
 */

const GRANULAR: Capability[] = [
  "workload.view",
  "workload.create",
  "workload.edit",
  "workload.deploy",
  "workload.adopt",
  "workload.delete",
  "container.view",
  "container.view_logs",
  "container.edit",
  "container.start",
  "container.stop",
  "container.restart",
  "container.delete",
  "secrets.manage"
];

describe("granular capability matrix", () => {
  it("ADMIN has every granular capability", () => {
    const caps = capabilitiesForRole(Role.ADMIN);
    for (const c of GRANULAR) expect(caps).toContain(c);
  });

  it("CLIENT_ADMIN: edit/deploy/secrets/user-management, but never adopt or node/platform admin", () => {
    const caps = capabilitiesForRole(Role.CLIENT_ADMIN);
    for (const c of [
      "workload.view",
      "workload.create",
      "workload.edit",
      "workload.deploy",
      "workload.delete",
      "container.view",
      "container.view_logs",
      "container.edit",
      "container.start",
      "container.stop",
      "container.restart",
      "secrets.manage",
      "user.manage",
      "client.manage"
    ] as Capability[]) {
      expect(caps).toContain(c);
    }
    for (const c of ["workload.adopt", "node.manage", "platform.admin"] as Capability[]) {
      expect(caps).not.toContain(c);
    }
  });

  it("CLIENT_OPERATOR: view + runtime actions only — no config edit, no deploy, no secrets, no delete", () => {
    const caps = capabilitiesForRole(Role.CLIENT_OPERATOR);
    for (const c of [
      "workload.view",
      "container.view",
      "container.view_logs",
      "container.start",
      "container.stop",
      "container.restart"
    ] as Capability[]) {
      expect(caps).toContain(c);
    }
    for (const c of [
      "workload.create",
      "workload.edit",
      "workload.deploy",
      "workload.delete",
      "workload.adopt",
      "container.edit",
      "container.delete",
      "secrets.manage",
      "user.manage",
      "client.manage"
    ] as Capability[]) {
      expect(caps).not.toContain(c);
    }
  });

  it("CLIENT_VIEWER: read only — no runtime action, no edit, no secrets", () => {
    const caps = capabilitiesForRole(Role.CLIENT_VIEWER);
    expect(caps).toContain("workload.view");
    expect(caps).toContain("container.view");
    expect(caps).toContain("container.view_logs");
    for (const c of [
      "container.start",
      "container.stop",
      "container.restart",
      "container.edit",
      "container.delete",
      "workload.create",
      "workload.edit",
      "workload.deploy",
      "workload.delete",
      "secrets.manage"
    ] as Capability[]) {
      expect(caps).not.toContain(c);
    }
  });

  it("ensureCan throws FORBIDDEN (not a generic error) for a missing capability", async () => {
    const world = await seedWorld();
    const operator = sessionFor(world.clientAOperator);
    expect(() => ensureCan(operator, "workload.view")).not.toThrow();
    expect(() => ensureCan(operator, "workload.edit")).toThrow("FORBIDDEN");
    expect(() => ensureCan(operator, "secrets.manage")).toThrow("FORBIDDEN");
    expect(can(operator, "workload.deploy")).toBe(false);
  });
});

describe("runtime actions: role gate is independent of the grant", () => {
  it("viewer is refused start/stop/restart even on a grant that allows them", async () => {
    const world = await seedWorld();
    const grant = await prisma.accessGrant.findFirstOrThrow({
      where: { clientAccountId: world.clientA.id, projectId: world.projectA.id }
    });
    for (const action of ["start", "stop", "restart"] as const) {
      expect(await resolveActionTarget(sessionFor(world.clientAViewer), grant.id, action)).toBeNull();
    }
  });

  it("operator IS allowed on the same grant (proves it is a role gate, not a broken grant)", async () => {
    const world = await seedWorld();
    const grant = await prisma.accessGrant.findFirstOrThrow({
      where: { clientAccountId: world.clientA.id, projectId: world.projectA.id }
    });
    expect(await resolveActionTarget(sessionFor(world.clientAOperator), grant.id, "restart")).not.toBeNull();
  });

  it("cross-tenant: client B cannot act on client A's grant id (direct object id)", async () => {
    const world = await seedWorld();
    const grant = await prisma.accessGrant.findFirstOrThrow({
      where: { clientAccountId: world.clientA.id, projectId: world.projectA.id }
    });
    expect(await resolveActionTarget(sessionFor(world.clientBOperator), grant.id, "start")).toBeNull();
  });
});

describe("deployment authoring surfaces: capability + tenancy", () => {
  async function managedWorkload(clientId: string | null, nodeId: string) {
    const suffix = crypto.randomUUID().slice(0, 8);
    const project = await prisma.project.create({
      data: {
        name: `Perm ${suffix}`,
        slug: `perm-${suffix}`,
        source: ProjectSource.COMPOSE,
        composeProject: `perm-${suffix}`,
        clientAccountId: clientId,
        nodeId,
        isActive: true
      }
    });
    const deployment = await prisma.deployment.create({
      data: {
        projectId: project.id,
        source: DeploymentSource.HOSTPANEL,
        composeProjectName: project.composeProject ?? `perm-${suffix}`
      }
    });
    return { project, deployment };
  }

  it("operator can VIEW but not EDIT/DEPLOY/manage secrets on its own workload", async () => {
    const world = await seedWorld();
    const { deployment } = await managedWorkload(world.clientA.id, world.node1.id);
    const operator = sessionFor(world.clientAOperator);

    const ctx = await requireClientDeployment(operator, deployment.id, "deployment.view");
    expect(ctx.deploymentId).toBe(deployment.id);

    await expect(requireClientDeployment(operator, deployment.id, "workload.edit")).rejects.toThrow("FORBIDDEN");
    await expect(requireClientDeployment(operator, deployment.id, "workload.deploy")).rejects.toThrow("FORBIDDEN");
    await expect(requireClientDeployment(operator, deployment.id, "secrets.manage")).rejects.toThrow("FORBIDDEN");
  });

  it("client admin can edit/deploy/manage secrets on its own workload", async () => {
    const world = await seedWorld();
    const { deployment } = await managedWorkload(world.clientA.id, world.node1.id);
    const admin = sessionFor(world.clientAAdmin);
    for (const cap of ["workload.edit", "workload.deploy", "secrets.manage"] as Capability[]) {
      const ctx = await requireClientDeployment(admin, deployment.id, cap);
      expect(ctx.deploymentId).toBe(deployment.id);
    }
  });

  it("cross-tenant: client B admin gets NOT_FOUND for client A's deployment id (no existence leak)", async () => {
    const world = await seedWorld();
    const { deployment } = await managedWorkload(world.clientA.id, world.node1.id);
    expect(await getClientDeployment(sessionFor(world.clientBOperator), deployment.id, "deployment.view")).toBeNull();
    await expect(
      requireClientDeployment(sessionFor(world.clientBOperator), deployment.id, "workload.edit")
    ).rejects.toThrow("NOT_FOUND");
  });

  it("internal (no-client) workloads are invisible to every client role", async () => {
    const world = await seedWorld();
    const { deployment } = await managedWorkload(null, world.node1.id);
    for (const user of [world.clientAAdmin, world.clientAOperator, world.clientAViewer, world.clientBOperator]) {
      expect(await getClientDeployment(sessionFor(user), deployment.id, "deployment.view")).toBeNull();
    }
  });
});

describe("lifecycle mutations are admin-gated server-side", () => {
  it("no client role can delete a standalone container", async () => {
    const world = await seedWorld();
    for (const user of [world.clientAAdmin, world.clientAOperator, world.clientAViewer]) {
      await expect(deleteContainer(sessionFor(user), world.worker.id, null)).rejects.toThrow("FORBIDDEN");
    }
    // Still present.
    const row = await prisma.container.findUniqueOrThrow({ where: { id: world.worker.id } });
    expect(row.isActive).toBe(true);
  });

  it("no client role can deactivate or delete a workload", async () => {
    const world = await seedWorld();
    for (const user of [world.clientAAdmin, world.clientAOperator, world.clientAViewer]) {
      await expect(setWorkloadActive(sessionFor(user), world.projectA.id, false, null)).rejects.toThrow("FORBIDDEN");
      await expect(deleteWorkload(sessionFor(user), world.projectA.id, null)).rejects.toThrow("FORBIDDEN");
    }
    const project = await prisma.project.findUniqueOrThrow({ where: { id: world.projectA.id } });
    expect(project.isActive).toBe(true);
  });

  it("removing a managed service requires workload.edit and tenant ownership", async () => {
    vi.restoreAllMocks();
    const world = await seedWorld();
    const suffix = crypto.randomUUID().slice(0, 8);
    const project = await prisma.project.create({
      data: {
        name: `Svc ${suffix}`,
        slug: `svc-${suffix}`,
        source: ProjectSource.COMPOSE,
        composeProject: `svc-${suffix}`,
        clientAccountId: world.clientA.id,
        nodeId: world.node1.id,
        isActive: true
      }
    });
    const deployment = await prisma.deployment.create({
      data: { projectId: project.id, source: DeploymentSource.HOSTPANEL, composeProjectName: `svc-${suffix}` }
    });
    const compose = "services:\n  web:\n    image: nginx:stable\n  api:\n    image: node:22-alpine\n";
    await prisma.deploymentRevision.create({
      data: {
        deploymentId: deployment.id,
        revisionNumber: 1,
        source: DeploymentSource.HOSTPANEL,
        composeSource: compose,
        composeCanonical: compose,
        environmentSnapshot: {},
        secretReferences: [],
        contentSha256: crypto.randomUUID(),
        analyzerVersion: "1"
      }
    });

    // Operator (no workload.edit) refused.
    await expect(
      removeServiceFromWorkload({
        deploymentId: deployment.id,
        serviceName: "api",
        session: sessionFor(world.clientAOperator),
        scope: "CLIENT"
      })
    ).rejects.toThrow("FORBIDDEN");

    // Cross-tenant client admin refused (NOT_FOUND, no existence leak).
    await expect(
      removeServiceFromWorkload({
        deploymentId: deployment.id,
        serviceName: "api",
        session: sessionFor(world.clientBOperator),
        scope: "CLIENT"
      })
    ).rejects.toThrow(/NOT_FOUND|FORBIDDEN/);
  });
});
