import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "./helpers/db";
import { resetDatabase } from "./setup";
import { seedWorld, sessionFor } from "./helpers/fixtures";
import { syncAttentionState } from "@/server/services/attention";
import {
  acknowledgeAttention,
  createAttentionSilence,
  getLifecyclePolicyContext,
  scheduleMaintenance,
  unacknowledgeAttention
} from "@/server/services/attention-lifecycle";
import {
  createConditionNotificationEvent,
  createNotificationDestination,
  createNotificationRule,
  sweepNotificationPolicyTransitions
} from "@/server/services/notifications";

let world: Awaited<ReturnType<typeof seedWorld>>;

beforeAll(async () => {
  resetDatabase();
  world = await seedWorld();
});

async function openCondition(suffix: string, severity: "warning" | "critical" = "warning") {
  const resourceId = `${world.node1.id}:${suffix}`;
  await syncAttentionState([{
    resourceType: "CONTAINER",
    resourceId,
    conditionType: "CONTAINER_UNHEALTHY",
    severity,
    title: `${suffix} is unhealthy`,
    detail: "Fixture healthcheck failed",
    nodeId: world.node1.id
  }]);
  return prisma.attentionState.findUniqueOrThrow({
    where: {
      resourceType_resourceId_conditionType: {
        resourceType: "CONTAINER",
        resourceId,
        conditionType: "CONTAINER_UNHEALTHY"
      }
    }
  });
}

/** Destination + PLATFORM-scope rule routing every attention event type to it (Phase 4 split destinations from routing). */
async function createDestination(name: string) {
  const destination = await createNotificationDestination({
    type: "WEBHOOK",
    name,
    url: "http://127.0.0.1:9/hook",
    signingSecret: "test-signing-secret-123456",
    actor: sessionFor(world.adminA)
  });
  await createNotificationRule({
    name: `${name} rule`,
    scope: "PLATFORM",
    eventTypes: ["CONDITION_OPENED", "SEVERITY_ESCALATED", "CONDITION_RESOLVED", "SILENCE_EXPIRED_STILL_ACTIVE"],
    minSeverity: "WARNING",
    destinationId: destination.id,
    actor: sessionFor(world.adminA)
  });
  return destination;
}

describe("attention acknowledgement lifecycle", () => {
  it("acknowledges without resolving, preserves actor/note, and unacknowledges historically", async () => {
    const state = await openCondition(`ack-${Date.now()}`);
    const actor = sessionFor(world.adminA);
    const first = await acknowledgeAttention({
      attentionStateId: state.id,
      actor,
      note: "Investigating upstream DNS"
    });
    expect(first?.note).toBe("Investigating upstream DNS");
    expect(first?.acknowledgedBy?.displayName).toBe(world.adminA.displayName);

    const stillActive = await prisma.attentionState.findUniqueOrThrow({ where: { id: state.id } });
    expect(stillActive.resolvedAt).toBeNull();

    // Concurrent/repeated acknowledgement is idempotent under the partial
    // unique index; it never creates two active acknowledgement rows.
    await acknowledgeAttention({ attentionStateId: state.id, actor, note: "second request" });
    expect(await prisma.attentionAcknowledgement.count({ where: { attentionStateId: state.id, clearedAt: null } })).toBe(1);

    await unacknowledgeAttention({ attentionStateId: state.id, actor });
    expect(await prisma.attentionAcknowledgement.count({ where: { attentionStateId: state.id, clearedAt: null } })).toBe(0);
    const history = await prisma.attentionAcknowledgement.findMany({ where: { attentionStateId: state.id } });
    expect(history).toHaveLength(1);
    expect(history[0].clearedReason).toBe("manual");
    expect((await prisma.attentionState.findUniqueOrThrow({ where: { id: state.id } })).resolvedAt).toBeNull();
  });

  it("automatically clears acknowledgement only when underlying truth resolves", async () => {
    const state = await openCondition(`resolve-${Date.now()}`);
    await acknowledgeAttention({ attentionStateId: state.id, actor: sessionFor(world.adminA) });
    await syncAttentionState([]);
    const resolved = await prisma.attentionState.findUniqueOrThrow({ where: { id: state.id } });
    const acknowledgement = await prisma.attentionAcknowledgement.findFirstOrThrow({ where: { attentionStateId: state.id } });
    expect(resolved.resolvedAt).not.toBeNull();
    expect(acknowledgement.clearedAt).not.toBeNull();
    expect(acknowledgement.clearedReason).toBe("condition_resolved");
  });
});

describe("silence and maintenance policy", () => {
  it("silence suppresses delivery but never changes active severity or resolution", async () => {
    const state = await openCondition(`silence-${Date.now()}`, "critical");
    const destination = await createDestination(`silence-destination-${Date.now()}`);
    const now = new Date();
    const silence = await createAttentionSilence({
      scope: "CONDITION",
      attentionStateId: state.id,
      startsAt: now,
      endsAt: new Date(now.getTime() + 60_000),
      reason: "Known upstream work",
      actor: sessionFor(world.adminA)
    });
    const current = await prisma.attentionState.findUniqueOrThrow({ where: { id: state.id } });
    await createConditionNotificationEvent({
      state: current,
      type: "SEVERITY_ESCALATED",
      dedupeKey: `test:silenced:${state.id}`
    });
    const delivery = await prisma.notificationDelivery.findFirstOrThrow({
      where: { destinationId: destination.id, notificationEvent: { dedupeKey: `test:silenced:${state.id}` } }
    });
    expect(delivery.status).toBe("SUPPRESSED");
    expect((await prisma.attentionState.findUniqueOrThrow({ where: { id: state.id } })).severity).toBe("CRITICAL");
    expect((await prisma.attentionState.findUniqueOrThrow({ where: { id: state.id } })).resolvedAt).toBeNull();
    expect(silence.cancelledAt).toBeNull();
  });

  it("silence expiry emits at most one still-active event and never replays suppressed history", async () => {
    const state = await openCondition(`expiry-${Date.now()}`);
    await createDestination(`expiry-destination-${Date.now()}`);
    const startsAt = new Date();
    const silence = await createAttentionSilence({
      scope: "CONDITION",
      attentionStateId: state.id,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 1000),
      actor: sessionFor(world.adminA)
    });
    const afterExpiry = new Date(startsAt.getTime() + 2000);
    await sweepNotificationPolicyTransitions(afterExpiry);
    await sweepNotificationPolicyTransitions(new Date(afterExpiry.getTime() + 1000));
    expect(await prisma.notificationEvent.count({ where: { dedupeKey: { startsWith: `silence:${silence.id}:expired:` } } })).toBe(1);
    expect((await prisma.attentionSilence.findUniqueOrThrow({ where: { id: silence.id } })).expiredNotifiedAt).not.toBeNull();
  });

  it("node maintenance applies to descendant conditions without falsifying health, then emits once when it ends still active", async () => {
    const state = await openCondition(`maintenance-${Date.now()}`, "critical");
    await createDestination(`maintenance-destination-${Date.now()}`);
    const startsAt = new Date();
    const window = await scheduleMaintenance({
      scope: "NODE",
      nodeId: world.node1.id,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 1000),
      reason: "Kernel update",
      actor: sessionFor(world.adminA)
    });
    const activeContext = await getLifecyclePolicyContext(state, new Date(startsAt.getTime() + 500));
    expect(activeContext.activeMaintenance.map((item) => item.id)).toContain(window.id);
    expect(activeContext.notificationsSuppressed).toBe(true);
    expect((await prisma.attentionState.findUniqueOrThrow({ where: { id: state.id } })).resolvedAt).toBeNull();

    const after = new Date(startsAt.getTime() + 2000);
    await sweepNotificationPolicyTransitions(after);
    await sweepNotificationPolicyTransitions(new Date(after.getTime() + 1000));
    expect(await prisma.notificationEvent.count({ where: { dedupeKey: { startsWith: `maintenance:${window.id}:ended:` } } })).toBe(1);
    const processed = await prisma.maintenanceWindow.findUniqueOrThrow({ where: { id: window.id } });
    expect(processed.endedProcessedAt).not.toBeNull();
    expect((await prisma.attentionState.findUniqueOrThrow({ where: { id: state.id } })).resolvedAt).toBeNull();
  });
});
