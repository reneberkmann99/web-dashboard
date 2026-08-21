import { beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "./helpers/db";
import { resetDatabase } from "./setup";
import { seedWorld, sessionFor } from "./helpers/fixtures";
import {
  resolveVisibleContainersForSession,
  resolveActionTarget,
  getContainerByGrant
} from "@/server/services/containers";
import { getOperationForSession, listOperationsForSession } from "@/server/services/operations";

// The negative tests below are the mandatory proof that Client A cannot reach
// Client B resources by changing an ID in an API request. They exercise the
// exact service functions the route handlers call.

vi.mock("@/server/services/node-agent/client", () => ({
  nodeAgentClient: {
    listContainers: vi.fn().mockResolvedValue({ nodeOnline: true, containers: [] }),
    getContainer: vi.fn().mockResolvedValue({ nodeOnline: true, container: null }),
    getLogs: vi.fn().mockResolvedValue({ nodeOnline: true, logs: [] }),
    runAction: vi.fn().mockResolvedValue(true),
    checkHealth: vi.fn().mockResolvedValue(true),
    getNodeInfo: vi.fn().mockResolvedValue({})
  }
}));

beforeAll(async () => {
  resetDatabase();
  await seedWorld();
});

describe("tenant isolation — negative tests", () => {
  it("Client A operator cannot see Client B's containers (list)", async () => {
    const world = await seedWorld();
    const sessionA = sessionFor(world.clientAOperator);

    const visible = await resolveVisibleContainersForSession(sessionA);
    const ids = Array.from(visible.values()).map((r) => r.dockerContainerId);
    expect(ids).toContain(world.web.dockerContainerId); // via project grant
    expect(ids).toContain(world.worker.dockerContainerId); // via container grant
    expect(ids).not.toContain(world.api.dockerContainerId); // client B's container
  });

  it("Client A cannot resolve Client B's container grant by changing the grant id in the URL", async () => {
    const world = await seedWorld();
    const sessionA = sessionFor(world.clientAOperator);
    const sessionB = sessionFor(world.clientBOperator);

    // Find B's grant id (the id a malicious A would guess/steal).
    const bGrant = await prisma.accessGrant.findFirstOrThrow({
      where: { clientAccountId: world.clientB.id, containerId: world.api.id }
    });

    // B can resolve it…
    const bResult = await resolveActionTarget(sessionB, bGrant.id, "restart");
    expect(bResult?.dockerContainerId).toBe(world.api.dockerContainerId);

    // …A cannot, even with the exact same id.
    const aResult = await resolveActionTarget(sessionA, bGrant.id, "restart");
    expect(aResult).toBeNull();

    const aDetail = await getContainerByGrant(sessionA, bGrant.id);
    expect(aDetail.container).toBeNull();
  });

  it("Client A cannot act on Client B's legacy assignment id either", async () => {
    const world = await seedWorld();
    const sessionA = sessionFor(world.clientAOperator);
    const sessionB = sessionFor(world.clientBOperator);

    const bAssignment = await prisma.containerAssignment.findFirstOrThrow({
      where: { clientAccountId: world.clientB.id }
    });

    expect(await resolveActionTarget(sessionB, bAssignment.id, "stop")).not.toBeNull();
    expect(await resolveActionTarget(sessionA, bAssignment.id, "stop")).toBeNull();
  });

  it("Client A cannot see Client B's operations", async () => {
    const world = await seedWorld();
    const sessionA = sessionFor(world.clientAOperator);
    const sessionB = sessionFor(world.clientBOperator);

    const op = await prisma.operation.create({
      data: {
        type: "CONTAINER_RESTART",
        state: "RUNNING",
        requestId: "req-b-1",
        actorUserId: world.clientBOperator.id,
        actorEmail: world.clientBOperator.email,
        actorRole: world.clientBOperator.role,
        clientAccountId: world.clientB.id,
        nodeId: world.node2.id,
        dockerContainerId: world.api.dockerContainerId,
        containerId: world.api.id
      }
    });

    expect((await getOperationForSession(sessionB, op.id))?.id).toBe(op.id);
    expect(await getOperationForSession(sessionA, op.id)).toBeNull();

    const aOps = await listOperationsForSession(sessionA);
    expect(aOps.some((o) => o.id === op.id)).toBe(false);
  });

  it("CLIENT_VIEWER cannot perform actions even on granted containers", async () => {
    const world = await seedWorld();
    const viewer = sessionFor(world.clientAViewer);

    // Viewer can see the project container…
    const visible = await resolveVisibleContainersForSession(viewer);
    expect(Array.from(visible.values()).some((r) => r.dockerContainerId === world.web.dockerContainerId)).toBe(true);

    // …but cannot act on it. The project grant for client A DOES allow start,
    // so this proves the ROLE capability gate is enforced independently of the
    // grant: resolveActionTarget refuses a viewer outright.
    const projectGrant = await prisma.accessGrant.findFirstOrThrow({
      where: { clientAccountId: world.clientA.id, projectId: world.projectA.id }
    });
    for (const action of ["start", "stop", "restart"] as const) {
      expect(await resolveActionTarget(viewer, projectGrant.id, action)).toBeNull();
    }

    // An operator on the same grant IS allowed — the refusal above is about the
    // role, not a broken grant.
    const operator = sessionFor(world.clientAOperator);
    expect(await resolveActionTarget(operator, projectGrant.id, "start")).not.toBeNull();
  });
});
