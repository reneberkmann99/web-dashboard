import { beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "./helpers/db";
import { resetDatabase } from "./setup";
import { seedWorld, sessionFor } from "./helpers/fixtures";
import { restartWorkload } from "@/server/services/workloads";
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
    getNodeInfo: vi.fn(),
    streamLogs: vi.fn()
  }
}));

beforeAll(async () => {
  resetDatabase();
});

describe("workload restart (batch operations)", () => {
  it("returns 404 for a non-existent workload", async () => {
    const world = await seedWorld();
    const admin = sessionFor(world.adminA);
    const result = await restartWorkload("nonexistent", admin);
    expect(result).toBeNull();
  });

  it("requests one operation per active container and all succeed", async () => {
    const world = await seedWorld();
    const admin = sessionFor(world.adminA);
    vi.mocked(nodeAgentClient.runAction).mockResolvedValue(true);

    // projectA has exactly one active container (web) in the fixture.
    const result = await restartWorkload(world.projectA.id, admin);
    expect(result).not.toBeNull();
    expect(result!.total).toBe(1);
    expect(result!.operationIds).toHaveLength(1);
    expect(result!.failures).toHaveLength(0);

    await waitForTerminal(result!.operationIds[0]);
    const op = await prisma.operation.findUniqueOrThrow({ where: { id: result!.operationIds[0] } });
    expect(op.state).toBe("SUCCEEDED");
    expect(op.type).toBe("CONTAINER_RESTART");
  });

  it("reports a partial failure without pretending success", async () => {
    const world = await seedWorld();
    const admin = sessionFor(world.adminA);

    // Pre-occupy the only container in projectA with an active operation so
    // the batch restart hits a conflict for it.
    await prisma.operation.create({
      data: {
        type: "CONTAINER_START",
        state: "RUNNING",
        requestId: "req-blocking",
        nodeId: world.node1.id,
        dockerContainerId: world.web.dockerContainerId,
        containerId: world.web.id
      }
    });

    const result = await restartWorkload(world.projectA.id, admin);
    expect(result).not.toBeNull();
    expect(result!.total).toBe(1);
    expect(result!.operationIds).toHaveLength(0);
    expect(result!.failures).toHaveLength(1);
    expect(result!.failures[0].reason).toContain("already in progress");
  });
});
