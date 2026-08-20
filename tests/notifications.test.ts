import crypto from "node:crypto";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "./helpers/db";
import { resetDatabase } from "./setup";
import { seedWorld, sessionFor } from "./helpers/fixtures";
import {
  createConditionNotificationEvent,
  createNotificationDestination,
  enqueueDueNotificationRetries,
  executeNotificationDelivery,
  listNotificationDestinations,
  processPendingNotificationDeliveries,
  retryNotificationDelivery,
  sendTestNotification
} from "@/server/services/notifications";
import { syncAttentionState } from "@/server/services/attention";

let world: Awaited<ReturnType<typeof seedWorld>>;
let server: http.Server;
let receiverUrl: string;
let responseStatus = 204;
const received: Array<{ body: string; headers: http.IncomingHttpHeaders }> = [];

beforeAll(async () => {
  resetDatabase();
  world = await seedWorld();
  server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      received.push({ body: Buffer.concat(chunks).toString("utf8"), headers: request.headers });
      response.statusCode = responseStatus;
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test receiver failed to listen");
  receiverUrl = `http://127.0.0.1:${address.port}/hostpanel-hook`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

async function createState(suffix: string, severity: "WARNING" | "CRITICAL" = "WARNING") {
  return prisma.attentionState.create({
    data: {
      resourceType: "NODE",
      resourceId: `${world.node1.id}-${suffix}`,
      conditionType: "NODE_OFFLINE",
      severity,
      title: `Fixture node ${suffix} is offline`,
      detail: "No heartbeat received",
      metadata: { nodeId: world.node1.id }
    }
  });
}

async function destination(suffix: string, options?: { enabled?: boolean }) {
  return createNotificationDestination({
    name: `Operations ${suffix}`,
    url: receiverUrl,
    signingSecret: "fixture-signing-secret-123456",
    authHeader: "Bearer fixture-auth-token",
    enabled: options?.enabled,
    minSeverity: "WARNING",
    eventTypes: ["CONDITION_OPENED", "SEVERITY_ESCALATED", "CONDITION_RESOLVED", "SILENCE_EXPIRED_STILL_ACTIVE"],
    actor: sessionFor(world.adminA)
  });
}

describe("notification event generation", () => {
  it("generates opened exactly once and never generates per-poll duplicates", async () => {
    const state = await createState(`dedupe-${Date.now()}`);
    const dest = await destination(`dedupe-${Date.now()}`);
    const dedupeKey = `${state.id}:opened:${state.firstObservedAt.toISOString()}`;
    const first = await createConditionNotificationEvent({ state, type: "CONDITION_OPENED", dedupeKey });
    const second = await createConditionNotificationEvent({ state, type: "CONDITION_OPENED", dedupeKey });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(await prisma.notificationEvent.count({ where: { dedupeKey } })).toBe(1);
    expect(await prisma.notificationDelivery.count({ where: { destinationId: dest.id, notificationEvent: { dedupeKey } } })).toBe(1);
  });

  it("emits severity escalation and resolution without recreating the condition", async () => {
    const suffix = `transition-${Date.now()}`;
    const resourceId = `${world.node1.id}:${suffix}`;
    await destination(suffix);
    await syncAttentionState([{
      resourceType: "CONTAINER",
      resourceId,
      conditionType: "CONTAINER_UNHEALTHY",
      severity: "warning",
      title: `${suffix} unhealthy`,
      detail: "warning",
      nodeId: world.node1.id
    }]);
    const state = await prisma.attentionState.findUniqueOrThrow({
      where: { resourceType_resourceId_conditionType: { resourceType: "CONTAINER", resourceId, conditionType: "CONTAINER_UNHEALTHY" } }
    });
    await syncAttentionState([{
      resourceType: "CONTAINER",
      resourceId,
      conditionType: "CONTAINER_UNHEALTHY",
      severity: "critical",
      title: `${suffix} unhealthy`,
      detail: "critical",
      nodeId: world.node1.id
    }]);
    await syncAttentionState([]);
    const events = await prisma.notificationEvent.findMany({ where: { attentionStateId: state.id }, orderBy: { occurredAt: "asc" } });
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["CONDITION_OPENED", "SEVERITY_ESCALATED", "CONDITION_RESOLVED"]));
    expect(new Set(events.map((event) => event.attentionStateId))).toEqual(new Set([state.id]));
  });

  it("disabled destinations receive no newly queued operational deliveries", async () => {
    const state = await createState(`disabled-${Date.now()}`);
    const dest = await destination(`disabled-${Date.now()}`, { enabled: false });
    await createConditionNotificationEvent({
      state,
      type: "CONDITION_OPENED",
      dedupeKey: `disabled:${state.id}`
    });
    expect(await prisma.notificationDelivery.count({ where: { destinationId: dest.id } })).toBe(0);
  });
});

describe("signed webhook delivery", () => {
  it("delivers one versioned structured payload with HMAC headers and HTTPS deep link", async () => {
    received.length = 0;
    responseStatus = 204;
    const state = await createState(`delivery-${Date.now()}`, "CRITICAL");
    const dest = await destination(`delivery-${Date.now()}`);
    const event = await createConditionNotificationEvent({
      state,
      type: "CONDITION_OPENED",
      dedupeKey: `delivery:${state.id}`
    });
    const delivery = await prisma.notificationDelivery.findFirstOrThrow({
      where: { destinationId: dest.id, notificationEventId: event.eventId }
    });
    await executeNotificationDelivery(delivery.id);

    expect(received).toHaveLength(1);
    const body = JSON.parse(received[0].body);
    expect(body.schemaVersion).toBe(1);
    expect(body.event).toBe("CONDITION_OPENED");
    expect(body.condition.id).toBe(state.id);
    expect(body.url).toMatch(/^https:\/\/hostpanel\.test/);
    expect(received[0].headers.authorization).toBe("Bearer fixture-auth-token");
    expect(received[0].headers["x-hostpanel-event-id"]).toBe(event.eventId);
    const timestamp = String(received[0].headers["x-hostpanel-timestamp"]);
    const expected = crypto.createHmac("sha256", "fixture-signing-secret-123456")
      .update(`${timestamp}.${received[0].body}`)
      .digest("hex");
    expect(received[0].headers["x-hostpanel-signature"]).toBe(`sha256=${expected}`);
    expect((await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).status).toBe("DELIVERED");
  });

  it("send test is explicitly TEST_NOTIFICATION and creates no fake condition", async () => {
    received.length = 0;
    responseStatus = 200;
    const dest = await destination(`test-${Date.now()}`);
    const conditionCount = await prisma.attentionState.count();
    const delivery = await sendTestNotification({ destinationId: dest.id, actor: sessionFor(world.adminA) });
    expect(delivery.status).toBe("DELIVERED");
    expect(delivery.isTest).toBe(true);
    expect(await prisma.attentionState.count()).toBe(conditionCount);
    expect(JSON.parse(received.at(-1)!.body).event).toBe("TEST_NOTIFICATION");
  });

  it("never returns encrypted URL, auth token, or signing secret from destination reads", async () => {
    await destination(`secret-view-${Date.now()}`);
    const json = JSON.stringify(await listNotificationDestinations());
    expect(json).not.toContain("urlEncrypted");
    expect(json).not.toContain("fixture-auth-token");
    expect(json).not.toContain("fixture-signing-secret");
    expect(json).toContain("••••••");
  });
});

describe("bounded retry and restart persistence", () => {
  it("persists failure attempts and stops after three attempts", async () => {
    responseStatus = 503;
    const state = await createState(`retry-${Date.now()}`, "CRITICAL");
    const dest = await destination(`retry-${Date.now()}`);
    const event = await createConditionNotificationEvent({ state, type: "CONDITION_OPENED", dedupeKey: `retry:${state.id}` });

    await processPendingNotificationDeliveries(100);
    await enqueueDueNotificationRetries(new Date(Date.now() + 10_000));
    await processPendingNotificationDeliveries(100);
    await enqueueDueNotificationRetries(new Date(Date.now() + 20_000));
    await processPendingNotificationDeliveries(100);
    await enqueueDueNotificationRetries(new Date(Date.now() + 30_000));

    const attempts = await prisma.notificationDelivery.findMany({
      where: { notificationEventId: event.eventId, destinationId: dest.id },
      orderBy: { attemptNumber: "asc" }
    });
    expect(attempts.map((attempt) => attempt.attemptNumber)).toEqual([1, 2, 3]);
    expect(attempts.every((attempt) => attempt.status === "FAILED")).toBe(true);
    expect(attempts.at(-1)?.nextRetryAt).toBeNull();
    expect((await prisma.notificationDestination.findUniqueOrThrow({ where: { id: dest.id } })).consecutiveFailures).toBe(3);
  });

  it("manual retry appends an attempt without duplicating the logical event", async () => {
    responseStatus = 503;
    const state = await createState(`manual-${Date.now()}`);
    const dest = await destination(`manual-${Date.now()}`);
    const event = await createConditionNotificationEvent({ state, type: "CONDITION_OPENED", dedupeKey: `manual:${state.id}` });
    const first = await prisma.notificationDelivery.findFirstOrThrow({ where: { notificationEventId: event.eventId, destinationId: dest.id } });
    await executeNotificationDelivery(first.id);
    const retry = await retryNotificationDelivery({ deliveryId: first.id, actor: sessionFor(world.adminA) });
    expect(retry.attemptNumber).toBe(2);
    expect(retry.isManualRetry).toBe(true);
    expect(await prisma.notificationEvent.count({ where: { id: event.eventId } })).toBe(1);
  });
});
