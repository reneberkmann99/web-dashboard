import { beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "./helpers/db";
import { resetDatabase } from "./setup";
import { seedWorld, sessionFor } from "./helpers/fixtures";
import { requestOperation, executeOperation, OperationConflictError } from "@/server/services/operations";
import { nodeAgentClient } from "@/server/services/node-agent/client";


async function waitForTerminal(opId: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const op = await prisma.operation.findUniqueOrThrow({ where: { id: opId } });
    if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(op.state)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("operation did not reach a terminal state in time");
}

vi.mock("@/server/services/node-agent/client", () => ({
  nodeAgentClient: {
    listContainers: vi.fn(),
    getContainer: vi.fn(),
    getLogs: vi.fn(),
    runAction: vi.fn(),
    checkHealth: vi.fn(),
    getNodeInfo: vi.fn()
  }
}));

beforeAll(async () => {
  resetDatabase();
  await seedWorld();
});

describe("operation lifecycle", () => {
  it("transitions REQUESTED -> QUEUED -> RUNNING -> SUCCEEDED", async () => {
    const world = await seedWorld();
    const session = sessionFor(world.clientAOperator);
    vi.mocked(nodeAgentClient.runAction).mockResolvedValueOnce(true);

    const opId = await requestOperation({
      type: "CONTAINER_RESTART",
      actor: session,
      clientAccountId: world.clientA.id,
      nodeId: world.node1.id,
      dockerContainerId: world.web.dockerContainerId,
      containerId: world.web.id
    });

    await waitForTerminal(opId);
    const op = await prisma.operation.findUniqueOrThrow({ where: { id: opId } });
    expect(op.state).toBe("SUCCEEDED");
    expect(op.startedAt).not.toBeNull();
    expect(op.finishedAt).not.toBeNull();
    expect(op.requestId).toBeTruthy();
    expect(op.actorEmail).toBe(world.clientAOperator.email);
    expect(op.clientAccountId).toBe(world.clientA.id);
    expect(op.nodeId).toBe(world.node1.id);
    expect(op.dockerContainerId).toBe(world.web.dockerContainerId);
  });

  it("transitions to FAILED when the agent rejects the action", async () => {
    const world = await seedWorld();
    const session = sessionFor(world.clientAOperator);
    vi.mocked(nodeAgentClient.runAction).mockResolvedValueOnce(false);

    const opId = await requestOperation({
      type: "CONTAINER_STOP",
      actor: session,
      clientAccountId: world.clientA.id,
      nodeId: world.node1.id,
      dockerContainerId: world.web.dockerContainerId,
      containerId: world.web.id
    });

    await waitForTerminal(opId);
    const op = await prisma.operation.findUniqueOrThrow({ where: { id: opId } });
    expect(op.state).toBe("FAILED");
    expect(op.error).toBeTruthy();
  });

  it("refuses a second operation on the same container while one is active", async () => {
    const world = await seedWorld();
    const session = sessionFor(world.clientAOperator);

    // Create a RUNNING operation directly (as if the executor were mid-flight).
    await prisma.operation.create({
      data: {
        type: "CONTAINER_START",
        state: "RUNNING",
        requestId: "req-conflict",
        actorUserId: world.clientAOperator.id,
        actorEmail: world.clientAOperator.email,
        actorRole: world.clientAOperator.role,
        clientAccountId: world.clientA.id,
        nodeId: world.node1.id,
        dockerContainerId: world.web.dockerContainerId,
        containerId: world.web.id
      }
    });

    await expect(
      requestOperation({
        type: "CONTAINER_RESTART",
        actor: session,
        clientAccountId: world.clientA.id,
        nodeId: world.node1.id,
        dockerContainerId: world.web.dockerContainerId,
        containerId: world.web.id
      })
    ).rejects.toBeInstanceOf(OperationConflictError);
  });

  it("after a terminal state, a new operation is allowed", async () => {
    const world = await seedWorld();
    const session = sessionFor(world.clientAOperator);
    vi.mocked(nodeAgentClient.runAction).mockResolvedValue(true);

    // Clear any active op on web (previous tests may have left state).
    await prisma.operation.updateMany({
      where: { dockerContainerId: world.web.dockerContainerId, state: "RUNNING" },
      data: { state: "SUCCEEDED", finishedAt: new Date() }
    });

    const opId = await requestOperation({
      type: "CONTAINER_START",
      actor: session,
      clientAccountId: world.clientA.id,
      nodeId: world.node1.id,
      dockerContainerId: world.web.dockerContainerId,
      containerId: world.web.id
    });
    await waitForTerminal(opId);
    const op = await prisma.operation.findUniqueOrThrow({ where: { id: opId } });
    expect(op.state).toBe("SUCCEEDED");
  });

  it("fails fast when the node is disabled", async () => {
    const world = await seedWorld();
    const session = sessionFor(world.clientAOperator);
    await prisma.node.update({ where: { id: world.node1.id }, data: { isActive: false, status: "INACTIVE" } });

    const opId = await requestOperation({
      type: "CONTAINER_RESTART",
      actor: session,
      clientAccountId: world.clientA.id,
      nodeId: world.node1.id,
      dockerContainerId: world.web.dockerContainerId,
      containerId: world.web.id
    });
    await waitForTerminal(opId);
    const op = await prisma.operation.findUniqueOrThrow({ where: { id: opId } });
    expect(op.state).toBe("FAILED");
    expect(op.error).toContain("Node is disabled");

    await prisma.node.update({ where: { id: world.node1.id }, data: { isActive: true, status: "ONLINE" } });
  });

  it("writes audit events for request and terminal transition", async () => {
    const world = await seedWorld();
    const session = sessionFor(world.clientAOperator);
    vi.mocked(nodeAgentClient.runAction).mockResolvedValue(true);

    const before = await prisma.auditLog.count();
    const opId = await requestOperation({
      type: "CONTAINER_RESTART",
      actor: session,
      clientAccountId: world.clientA.id,
      nodeId: world.node1.id,
      dockerContainerId: world.worker.dockerContainerId,
      containerId: world.worker.id
    });
    await waitForTerminal(opId);
    const after = await prisma.auditLog.count();
    expect(after - before).toBeGreaterThanOrEqual(2);

    const events = await prisma.auditLog.findMany({
      where: { targetId: opId },
      orderBy: { createdAt: "asc" }
    });
    const actions = events.map((e) => e.action);
    expect(actions).toContain("CONTAINER_RESTART_REQUESTED");
    expect(actions.some((a) => a.startsWith("CONTAINER_RESTART_"))).toBe(true);
  });
});
