import { beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "./helpers/db";
import { resetDatabase } from "./setup";
import { seedWorld, sessionFor } from "./helpers/fixtures";
import {
  setWorkloadActive,
  deleteWorkload,
  buildWorkloadDeletionPlan,
  WorkloadLifecycleError
} from "@/server/services/workload-lifecycle";
import { nodeAgentClient } from "@/server/services/node-agent/client";

beforeAll(async () => {
  resetDatabase();
});

async function expectError(fn: () => Promise<unknown>, message: string): Promise<void> {
  await expect(fn()).rejects.toThrow(message);
}

describe("workload lifecycle — deactivate / delete / deletion plan", () => {
  it("deactivates and reactivates a workload without touching Docker", async () => {
    const world = await seedWorld();
    const admin = sessionFor(world.adminA);

    await setWorkloadActive(admin, world.projectA.id, false, null);
    expect((await prisma.project.findUnique({ where: { id: world.projectA.id } }))?.isActive).toBe(false);

    await setWorkloadActive(admin, world.projectA.id, true, null);
    expect((await prisma.project.findUnique({ where: { id: world.projectA.id } }))?.isActive).toBe(true);
  });

  it("builds a deletion plan listing containers, grants, and safe defaults", async () => {
    const world = await seedWorld();
    const plan = await buildWorkloadDeletionPlan(world.projectA.id);

    expect(plan).not.toBeNull();
    expect(plan?.name).toBe("Web Stack");
    expect(plan?.managed).toBe(false);
    expect(plan?.containers.map((c) => c.dockerName)).toContain("web");
    expect(plan?.grants.length).toBeGreaterThan(0);
    expect(plan?.namedVolumesPreserved).toBe(true);
    expect(plan?.networksPreserved).toBe(true);
  });

  it("refuses to delete a managed workload", async () => {
    const world = await seedWorld();
    const admin = sessionFor(world.adminA);

    // Attach a Deployment to make the workload managed.
    await prisma.deployment.create({
      data: { projectId: world.projectA.id, composeProjectName: "web-stack" }
    });

    await expectError(() => deleteWorkload(admin, world.projectA.id, null), "MANAGED_WORKLOAD");
    expect(await prisma.project.findUnique({ where: { id: world.projectA.id } })).not.toBeNull();
  });

  it("deletes a manual workload, removes containers via the agent, preserves audit", async () => {
    const world = await seedWorld();
    const admin = sessionFor(world.adminA);

    // Deterministic: mock the agent removal (no real HTTP in unit tests).
    const removeSpy = vi.spyOn(nodeAgentClient, "removeContainer").mockResolvedValue(true);

    await deleteWorkload(admin, world.projectA.id, null);

    expect(removeSpy).toHaveBeenCalled();
    // Project gone; containers SetNull (projectId cleared), not hard-deleted.
    expect(await prisma.project.findUnique({ where: { id: world.projectA.id } })).toBeNull();
    const orphaned = await prisma.container.findUnique({ where: { id: world.web.id } });
    expect(orphaned?.projectId).toBeNull();

    // Audit event written.
    const audit = await prisma.auditLog.findFirst({ where: { action: "WORKLOAD_DELETE", targetId: world.projectA.id } });
    expect(audit).not.toBeNull();

    removeSpy.mockRestore();
  });

  it("a client role cannot delete a workload", async () => {
    const world = await seedWorld();
    const clientAdminA = sessionFor(world.clientAAdmin);

    await expectError(() => deleteWorkload(clientAdminA, world.projectA.id, null), "FORBIDDEN");
  });
});
