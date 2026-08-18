import { beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "./helpers/db";
import { resetDatabase } from "./setup";
import { seedWorld, sessionFor } from "./helpers/fixtures";
import { resolveVisibleContainersForSession, listAllContainersForAdmin } from "@/server/services/containers";
import { nodeAgentClient } from "@/server/services/node-agent/client";

vi.mock("@/server/services/node-agent/client", () => ({
  nodeAgentClient: {
    listContainers: vi.fn(),
    getContainer: vi.fn(),
    getLogs: vi.fn(),
    runAction: vi.fn(),
    checkHealth: vi.fn(),
    getNodeInfo: vi.fn().mockResolvedValue({})
  }
}));

beforeAll(async () => {
  resetDatabase();
  await seedWorld();
});

describe("data consistency guards", () => {
  it("a deactivated client account loses all visibility immediately", async () => {
    const world = await seedWorld();
    const session = sessionFor(world.clientAOperator);

    // Sanity: visible before deactivation.
    const before = await resolveVisibleContainersForSession(session);
    expect(before.size).toBeGreaterThan(0);

    await prisma.clientAccount.update({ where: { id: world.clientA.id }, data: { isActive: false } });
    const after = await resolveVisibleContainersForSession(session);
    expect(after.size).toBe(0);

    await prisma.clientAccount.update({ where: { id: world.clientA.id }, data: { isActive: true } });
  });

  it("stale containers (no longer reported by the agent) are marked inactive, not deleted", async () => {
    const world = await seedWorld();
    // Agent reports only 'web'; 'worker' and 'api' have vanished.
    vi.mocked(nodeAgentClient.listContainers).mockResolvedValue({
      nodeOnline: true,
      containers: [
        {
          id: world.web.dockerContainerId,
          name: "web",
          image: "nginx:latest",
          status: "running",
          uptime: "2 hours",
          ports: "80/tcp",
          createdAt: new Date().toISOString(),
          cpuPercent: 0.1,
          memoryUsage: "10MiB",
          restartCount: 0,
          lastUpdatedAt: new Date().toISOString()
        }
      ]
    });

    const admin = sessionFor(world.adminA);
    const view = await listAllContainersForAdmin();
    // Admin still sees the one reported container.
    expect(view.some((c) => c.containerId === world.web.dockerContainerId)).toBe(true);

    // The stale container row was annotated, not deleted.
    const workerRow = await prisma.container.findUniqueOrThrow({
      where: { nodeId_dockerContainerId: { nodeId: world.node1.id, dockerContainerId: world.worker.dockerContainerId } }
    });
    expect(workerRow.isActive).toBe(false);

    // Its grant still exists (no silent permission deletion).
    const grant = await prisma.accessGrant.findFirst({
      where: { clientAccountId: world.clientA.id, containerId: workerRow.id }
    });
    expect(grant?.isActive).toBe(true);
  });

  it("client-role users are required to have a client account (DB CHECK)", async () => {
    await expect(
      prisma.user.create({
        data: {
          email: "orphan@example.com",
          displayName: "Orphan",
          passwordHash: "x",
          role: "CLIENT_OPERATOR",
          clientAccountId: null
        }
      })
    ).rejects.toThrow();

    // ADMIN without client is fine.
    await expect(
      prisma.user.create({
        data: {
          email: "root-admin@example.com",
          displayName: "Root",
          passwordHash: "x",
          role: "ADMIN",
          clientAccountId: null
        }
      })
    ).resolves.toBeTruthy();
  });

  it("duplicate container assignments are prevented by the unique constraint", async () => {
    const world = await seedWorld();
    // First assignment for the container succeeds…
    await prisma.containerAssignment.create({
      data: {
        clientAccountId: world.clientA.id,
        nodeId: world.node1.id,
        containerId: world.web.id,
        dockerContainerId: world.web.dockerContainerId,
        dockerName: "web",
        allowedActions: ["start"]
      }
    });
    // …the duplicate (same node + docker container) is rejected.
    await expect(
      prisma.containerAssignment.create({
        data: {
          clientAccountId: world.clientA.id,
          nodeId: world.node1.id,
          containerId: world.web.id,
          dockerContainerId: world.web.dockerContainerId,
          dockerName: "web",
          allowedActions: ["start"]
        }
      })
    ).rejects.toThrow();
  });
});
