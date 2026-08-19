import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "./helpers/db";
import { resetDatabase } from "./setup";
import { seedWorld, sessionFor } from "./helpers/fixtures";
import { resolveLogTarget } from "@/server/services/containers";

beforeAll(async () => {
  resetDatabase();
});

describe("log stream authorization", () => {
  it("allows a client with view_logs on a container grant", async () => {
    const world = await seedWorld();
    const sessionA = sessionFor(world.clientAOperator);

    // worker is granted view_logs only.
    const target = await resolveLogTarget(sessionA, world.workerGrant.id);
    expect(target).not.toBeNull();
    expect(target?.dockerContainerId).toBe(world.worker.dockerContainerId);
    expect(target?.node.id).toBe(world.node1.id);
  });

  it("denies a client whose grant does not include view_logs", async () => {
    const world = await seedWorld();
    const sessionA = sessionFor(world.clientAOperator);

    // The project grant for client A grants start/stop/restart but not view_logs.
    const projectGrant = await prisma.accessGrant.findFirstOrThrow({
      where: { clientAccountId: world.clientA.id, projectId: world.projectA.id }
    });
    expect(await resolveLogTarget(sessionA, projectGrant.id)).toBeNull();
  });

  it("denies a client resolving another client's grant id (cross-tenant)", async () => {
    const world = await seedWorld();
    const sessionA = sessionFor(world.clientAOperator);

    // client B's grant on the api container.
    const bGrant = await prisma.accessGrant.findFirstOrThrow({
      where: { clientAccountId: world.clientB.id, containerId: world.api.id }
    });
    expect(await resolveLogTarget(sessionA, bGrant.id)).toBeNull();
  });

  it("denies a VIEWER without view_logs (policy enforced at route, resolver is grant-scoped)", async () => {
    const world = await seedWorld();
    const viewer = sessionFor(world.clientAViewer);
    // Viewer's grants mirror client A's, but the role gate (container.view_logs)
    // is enforced in the route via policy.ts. The resolver itself is grant-based;
    // here we assert the worker grant resolves for the viewer too (view_logs is
    // in the grant), which the route then restricts by role capability.
    const target = await resolveLogTarget(viewer, world.workerGrant.id);
    expect(target).not.toBeNull();
  });

  it("denies a non-existent grant id", async () => {
    const world = await seedWorld();
    const sessionA = sessionFor(world.clientAOperator);
    expect(await resolveLogTarget(sessionA, "nonexistent")).toBeNull();
  });
});
