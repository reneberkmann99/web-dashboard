import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "./helpers/db";
import { resetDatabase } from "./setup";
import { seedWorld } from "./helpers/fixtures";
import {
  getRecentFailures,
  dismissRecentFailure,
  dismissAllRecentFailures
} from "@/server/services/attention";

let world: Awaited<ReturnType<typeof seedWorld>>;

beforeAll(async () => {
  resetDatabase();
  world = await seedWorld();
});

async function createFailedOperation(dockerContainerId: string, error: string, minutesAgo: number): Promise<void> {
  await prisma.operation.create({
    data: {
      type: "CONTAINER_START",
      state: "FAILED",
      requestId: randomUUID(),
      nodeId: world.node1.id,
      dockerContainerId,
      error,
      requestedAt: new Date(Date.now() - minutesAgo * 60_000),
      finishedAt: new Date(Date.now() - minutesAgo * 60_000)
    }
  });
}

describe("recent failures — grouping and dismissal", () => {
  it("groups repeated failures of the same incident into one entry with an attempts count", async () => {
    await createFailedOperation(world.web.dockerContainerId, "Port 8080 already allocated", 120);
    await createFailedOperation(world.web.dockerContainerId, "Port 8080 already allocated", 60);
    await createFailedOperation(world.web.dockerContainerId, "Port 8080 already allocated", 10);

    const failures = await getRecentFailures(50);
    const entries = failures.filter((f) => f.title === `Start failed — ${world.node1.name}`);
    expect(entries).toHaveLength(1);
    expect(entries[0].attempts).toBe(3);
    expect(entries[0].detail).toContain("Port 8080");
  });

  it("dismissing a failure removes it from the feed but never deletes the operation", async () => {
    await createFailedOperation(world.worker.dockerContainerId, "worker boom", 5);
    const failures = await getRecentFailures(50);
    const target = failures.find(
      (f) => f.title === `Start failed — ${world.node1.name}` && f.id.includes(world.worker.dockerContainerId)
    );
    expect(target).toBeDefined();

    await dismissRecentFailure(target!.id);

    const after = await getRecentFailures(50);
    expect(after.some((f) => f.id === target!.id)).toBe(false);

    // The underlying operation row still exists (dismissal is UI-only).
    const opCount = await prisma.operation.count({ where: { dockerContainerId: world.worker.dockerContainerId } });
    expect(opCount).toBeGreaterThan(0);
  });

  it("dismissAllRecentFailures clears the current feed", async () => {
    const failures = await getRecentFailures(50);
    const dismissed = await dismissAllRecentFailures();
    expect(dismissed).toBeGreaterThan(0);
    const after = await getRecentFailures(50);
    for (const f of failures) {
      expect(after.some((a) => a.id === f.id)).toBe(false);
    }
  });
});
