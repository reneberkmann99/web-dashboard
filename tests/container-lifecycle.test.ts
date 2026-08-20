import { beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "./helpers/db";
import { resetDatabase } from "./setup";
import { seedWorld, sessionFor } from "./helpers/fixtures";
import {
  deleteContainer,
  buildContainerDeletePlan,
  ContainerLifecycleError
} from "@/server/services/container-lifecycle";
import { nodeAgentClient } from "@/server/services/node-agent/client";

beforeAll(async () => {
  resetDatabase();
});

async function expectError(fn: () => Promise<unknown>, message: string): Promise<void> {
  await expect(fn()).rejects.toThrow(message);
}

describe("container lifecycle — delete / deletion plan", () => {
  it("builds a plan for a standalone container", async () => {
    const world = await seedWorld();
    const plan = await buildContainerDeletePlan(world.worker.id);

    expect(plan).not.toBeNull();
    expect(plan?.managed).toBe(false);
    expect(plan?.dockerName).toBe("worker");
    expect(plan?.namedVolumesPreserved).toBe(true);
  });

  it("flags a managed-workload service as managed in the plan", async () => {
    const world = await seedWorld();
    // Make the web container's project managed.
    await prisma.deployment.create({
      data: { projectId: world.projectA.id, composeProjectName: "web-stack" }
    });

    const plan = await buildContainerDeletePlan(world.web.id);
    expect(plan?.managed).toBe(true);
    expect(plan?.workloadName).toBe("Web Stack");
  });

  it("refuses to delete a managed workload service", async () => {
    const world = await seedWorld();
    const admin = sessionFor(world.adminA);

    await prisma.deployment.create({
      data: { projectId: world.projectA.id, composeProjectName: "web-stack" }
    });

    await expectError(() => deleteContainer(admin, world.web.id, null), "MANAGED_CONTAINER");
    expect((await prisma.container.findUnique({ where: { id: world.web.id } }))?.isActive).toBe(true);
  });

  it("deletes a standalone container via the agent and marks the row inactive", async () => {
    const world = await seedWorld();
    const admin = sessionFor(world.adminA);

    const removeSpy = vi.spyOn(nodeAgentClient, "removeContainer").mockResolvedValue(true);

    await deleteContainer(admin, world.worker.id, null);

    expect(removeSpy).toHaveBeenCalledWith(expect.objectContaining({ id: world.node1.id }), "worker12345678");
    expect((await prisma.container.findUnique({ where: { id: world.worker.id } }))?.isActive).toBe(false);

    const audit = await prisma.auditLog.findFirst({ where: { action: "CONTAINER_DELETE", targetId: world.worker.id } });
    expect(audit).not.toBeNull();

    removeSpy.mockRestore();
  });

  it("a client role cannot delete a container", async () => {
    const world = await seedWorld();
    const clientAOperator = sessionFor(world.clientAOperator);

    await expectError(() => deleteContainer(clientAOperator, world.worker.id, null), "FORBIDDEN");
  });
});
