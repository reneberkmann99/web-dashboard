import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "./helpers/db";
import { resetDatabase } from "./setup";
import { seedWorld } from "./helpers/fixtures";
import { getDeduplicatedAdminAttentionRows } from "@/server/services/attention";
import { resolveActivityTargetLabels } from "@/server/services/activity";

beforeAll(async () => {
  resetDatabase();
  await seedWorld();
});

describe("round 2: shell/Overview/Attention share one attention count", () => {
  it("the deduplicated feed used by shell summary, Overview, and Attention excludes INFO severity that a raw count would include", async () => {
    const world = await seedWorld();

    await prisma.attentionState.create({
      data: {
        resourceType: "NODE",
        resourceId: world.node1.id,
        conditionType: "NODE_OFFLINE",
        severity: "CRITICAL",
        title: "Node offline",
        detail: "test"
      }
    });
    await prisma.attentionState.create({
      data: {
        resourceType: "CONTAINER",
        resourceId: `${world.node1.id}:${world.web.dockerContainerId}`,
        conditionType: "CONTAINER_HIGH_CPU",
        severity: "INFO",
        title: "Info-level condition",
        detail: "test"
      }
    });

    const rawCount = await prisma.attentionState.count({ where: { resolvedAt: null } });
    const dedupedRows = await getDeduplicatedAdminAttentionRows();

    // Before the round-2 fix, /api/shell/summary counted `rawCount` (both
    // rows) while Overview/Attention counted the deduplicated feed (only the
    // CRITICAL row) — the sidebar badge could disagree with the page it
    // linked to. Both surfaces must now read from the same dedup query.
    expect(rawCount).toBeGreaterThan(dedupedRows.length);
    expect(dedupedRows.filter((r) => r.resourceId === world.node1.id)).toHaveLength(1);
    expect(dedupedRows.some((r) => r.severity === "INFO")).toBe(false);
  });
});

describe("round 2: Activity resolves ids to names, deleted resources keep a snapshot", () => {
  it("resolves a live node/container to its current name, not the raw id", async () => {
    const world = await seedWorld();
    const labels = await resolveActivityTargetLabels([
      { targetType: "NODE", targetId: world.node1.id, metadata: null },
      { targetType: "CONTAINER", targetId: world.web.id, metadata: null }
    ]);
    expect(labels.get(`NODE:${world.node1.id}`)).toEqual({ label: world.node1.name, deleted: false });
    expect(labels.get(`CONTAINER:${world.web.id}`)).toEqual({ label: "web", deleted: false });
  });

  it("resolves attention-derived CONTAINER audit rows, whose resourceId is `nodeId:dockerContainerId`, not the Container table's own cuid", async () => {
    const world = await seedWorld();
    const composite = `${world.node1.id}:${world.web.dockerContainerId}`;
    const labels = await resolveActivityTargetLabels([{ targetType: "CONTAINER", targetId: composite, metadata: { title: "web is unhealthy" } }]);
    expect(labels.get(`CONTAINER:${composite}`)).toEqual({ label: "web", deleted: false });
  });

  it("never marks a Node or Container '(deleted)' on a lookup miss — they're deactivated, never hard-deleted", async () => {
    const labels = await resolveActivityTargetLabels([
      { targetType: "NODE", targetId: "cnodethatnolongerexists001", metadata: { nodeName: "Ghost Node" } },
      { targetType: "CONTAINER", targetId: "ccontainerthatvanished0001", metadata: null }
    ]);
    expect(labels.get("NODE:cnodethatnolongerexists001")).toEqual({ label: "Ghost Node", deleted: false });
    expect(labels.get("CONTAINER:ccontainerthatvanished0001")).toEqual({ label: null, deleted: false });
  });

  it("falls back to the metadata name snapshot and marks `deleted: true` once the row is hard-deleted", async () => {
    const world = await seedWorld();
    const ghostProjectId = "cghostprojectid00000000001";
    const labels = await resolveActivityTargetLabels([
      { targetType: "PROJECT", targetId: ghostProjectId, metadata: { name: "Mailcow" } },
      { targetType: "USER", targetId: "cghostuserid000000000002", metadata: { deletedDisplayName: "Test User", deletedEmail: "test@example.com" } }
    ]);
    expect(labels.get(`PROJECT:${ghostProjectId}`)).toEqual({ label: "Mailcow", deleted: true });
    expect(labels.get(`USER:cghostuserid000000000002`)).toEqual({ label: "Test User", deleted: true });
    void world;
  });
});
