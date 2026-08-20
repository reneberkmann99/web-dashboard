import crypto from "node:crypto";
import {
  Prisma,
  type AttentionResourceType,
  type AttentionSeverity,
  type NotificationEventType
} from "@prisma/client";
import { prisma } from "@/server/db";
import { logAuditEvent } from "@/server/audit";
import type { AuthSession } from "@/server/auth/session";
import { decryptSecret, encryptSecret, isEncryptionKeyConfigured } from "@/server/security/crypto";
import { postWebhook, resolveWebhookTarget } from "@/server/security/webhook-security";
import { getLifecyclePolicyContext, resolveConditionResourceContext } from "@/server/services/attention-lifecycle";

const MAX_DELIVERY_ATTEMPTS = 3;
const SEVERITY_RANK: Record<AttentionSeverity, number> = { INFO: 0, WARNING: 1, CRITICAL: 2 };

export type NotificationConditionState = {
  id: string;
  resourceType: AttentionResourceType;
  resourceId: string;
  conditionType: string;
  severity: AttentionSeverity;
  title: string;
  detail: string;
  href: string | null;
  metadata: unknown;
  firstObservedAt: Date;
  lastObservedAt: Date;
  resolvedAt: Date | null;
};

function publicBaseUrl(): URL {
  const raw = process.env.HOSTPANEL_PUBLIC_BASE_URL ?? "https://localhost:8443";
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("HOSTPANEL_PUBLIC_BASE_URL_MUST_BE_HTTPS");
  url.pathname = url.pathname.replace(/\/$/, "");
  return url;
}

function conditionHref(state: NotificationConditionState, workloadId: string | null): string | null {
  if (state.href?.startsWith("/")) return state.href;
  if (state.resourceType === "NODE") return `/admin/nodes/${encodeURIComponent(state.resourceId)}`;
  if (state.resourceType === "WORKLOAD") return `/admin/workloads/${encodeURIComponent(state.resourceId)}`;
  if (state.resourceType === "CONTAINER") {
    const separator = state.resourceId.indexOf(":");
    if (separator > 0) {
      const nodeId = state.resourceId.slice(0, separator);
      const dockerId = state.resourceId.slice(separator + 1);
      return `/admin/containers/${encodeURIComponent(nodeId)}/${encodeURIComponent(dockerId)}`;
    }
  }
  if (workloadId) return `/admin/workloads/${encodeURIComponent(workloadId)}`;
  return null;
}

function absoluteNoderaftUrl(relative: string | null): string | null {
  if (!relative) return null;
  return new URL(relative, publicBaseUrl()).toString();
}

function destinationAllowsSeverity(minimum: AttentionSeverity, actual: AttentionSeverity): boolean {
  return SEVERITY_RANK[actual] >= SEVERITY_RANK[minimum];
}

function destinationAllowsScope(
  destination: { scopeNodeIds: string[]; scopeWorkloadIds: string[] },
  context: { nodeId: string | null; workloadId: string | null }
): boolean {
  const global = destination.scopeNodeIds.length === 0 && destination.scopeWorkloadIds.length === 0;
  if (global) return true;
  return Boolean(
    (context.nodeId && destination.scopeNodeIds.includes(context.nodeId)) ||
    (context.workloadId && destination.scopeWorkloadIds.includes(context.workloadId))
  );
}

/**
 * Persist one logical event and its initial destination deliveries. The
 * deterministic dedupe key makes duplicate attention syncs harmless. No
 * outbound HTTP occurs here; the notification worker owns delivery.
 */
export async function createConditionNotificationEvent(input: {
  state: NotificationConditionState;
  type: Exclude<NotificationEventType, "TEST_NOTIFICATION">;
  dedupeKey: string;
  occurredAt?: Date;
  transitionReason?: string;
}): Promise<{ eventId: string; created: boolean; deliveries: number }> {
  const alreadyExisting = await prisma.notificationEvent.findUnique({
    where: { dedupeKey: input.dedupeKey },
    select: { id: true }
  });
  if (alreadyExisting) return { eventId: alreadyExisting.id, created: false, deliveries: 0 };
  const context = await getLifecyclePolicyContext(input.state, input.occurredAt ?? new Date());
  const id = crypto.randomUUID();
  const relativeUrl = conditionHref(input.state, context.workloadId);
  const payload = {
    schemaVersion: 1,
    eventId: id,
    event: input.type,
    ...(input.transitionReason ? { transitionReason: input.transitionReason } : {}),
    severity: input.state.severity,
    condition: {
      id: input.state.id,
      type: input.state.conditionType
    },
    resource: {
      type: input.state.resourceType,
      id: input.state.resourceId,
      name: input.state.title
    },
    summary: input.state.title,
    detail: input.state.detail,
    firstObservedAt: input.state.firstObservedAt.toISOString(),
    lastObservedAt: input.state.lastObservedAt.toISOString(),
    resolvedAt: input.state.resolvedAt?.toISOString() ?? null,
    url: absoluteNoderaftUrl(relativeUrl)
  };

  let eventId: string = id;
  let created = false;
  try {
    await prisma.notificationEvent.create({
      data: {
        id,
        dedupeKey: input.dedupeKey,
        type: input.type,
        attentionStateId: input.state.id,
        severity: input.state.severity,
        resourceType: input.state.resourceType,
        resourceId: input.state.resourceId,
        summary: input.state.title,
        payload,
        occurredAt: input.occurredAt ?? new Date()
      }
    });
    created = true;
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
    const existing = await prisma.notificationEvent.findUniqueOrThrow({ where: { dedupeKey: input.dedupeKey } });
    eventId = existing.id;
  }
  if (!created) return { eventId, created: false, deliveries: 0 };

  const destinations = await prisma.notificationDestination.findMany({
    where: { enabled: true, eventTypes: { has: input.type } },
    select: {
      id: true,
      minSeverity: true,
      scopeNodeIds: true,
      scopeWorkloadIds: true
    }
  });
  const eligible = destinations.filter((destination) =>
    destinationAllowsSeverity(destination.minSeverity, input.state.severity) &&
    destinationAllowsScope(destination, context)
  );
  if (eligible.length > 0) {
    await prisma.notificationDelivery.createMany({
      data: eligible.map((destination) => ({
        notificationEventId: eventId,
        destinationId: destination.id,
        attemptNumber: 1,
        status: context.notificationsSuppressed ? "SUPPRESSED" : "PENDING",
        error: context.notificationsSuppressed ? "SUPPRESSED_BY_OPERATOR_POLICY" : null,
        respondedAt: context.notificationsSuppressed ? new Date() : null
      })),
      skipDuplicates: true
    });
  }
  return { eventId, created: true, deliveries: eligible.length };
}

function maskWebhookUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  return `${url.protocol}//${url.host}/••••••`;
}

function validateAuthHeader(value?: string | null): string | null {
  const normalized = value?.trim() || null;
  if (normalized && (normalized.length > 2048 || /[\r\n]/.test(normalized))) {
    throw new Error("INVALID_AUTH_HEADER");
  }
  return normalized;
}

function requireNotificationEncryption(): void {
  if (!isEncryptionKeyConfigured("NOTIFICATION_DESTINATIONS")) {
    throw new Error("NOTIFICATION_ENCRYPTION_NOT_CONFIGURED");
  }
}

export async function createNotificationDestination(input: {
  name: string;
  url: string;
  authHeader?: string | null;
  signingSecret: string;
  enabled?: boolean;
  minSeverity?: AttentionSeverity;
  eventTypes: NotificationEventType[];
  scopeNodeIds?: string[];
  scopeWorkloadIds?: string[];
  actor: AuthSession;
  sourceIp?: string | null;
}) {
  requireNotificationEncryption();
  await resolveWebhookTarget(input.url);
  if (input.signingSecret.length < 16 || input.signingSecret.length > 1024) throw new Error("INVALID_SIGNING_SECRET");
  const destination = await prisma.notificationDestination.create({
    data: {
      name: input.name.trim(),
      urlEncrypted: encryptSecret(input.url, "NOTIFICATION_DESTINATIONS"),
      urlMasked: maskWebhookUrl(input.url),
      authHeaderEncrypted: validateAuthHeader(input.authHeader)
        ? encryptSecret(validateAuthHeader(input.authHeader)!, "NOTIFICATION_DESTINATIONS")
        : null,
      signingSecretEncrypted: encryptSecret(input.signingSecret, "NOTIFICATION_DESTINATIONS"),
      enabled: input.enabled ?? true,
      minSeverity: input.minSeverity ?? "WARNING",
      eventTypes: Array.from(new Set(input.eventTypes)),
      scopeNodeIds: Array.from(new Set(input.scopeNodeIds ?? [])),
      scopeWorkloadIds: Array.from(new Set(input.scopeWorkloadIds ?? [])),
      createdById: input.actor.userId
    },
    select: destinationPublicSelect
  });
  await logAuditEvent({
    actorUserId: input.actor.userId,
    actorEmail: input.actor.email,
    actorRole: input.actor.role,
    action: "NOTIFICATION_DESTINATION_CREATED",
    targetType: "NOTIFICATION_DESTINATION",
    targetId: destination.id,
    metadata: { name: destination.name, type: destination.type, enabled: destination.enabled },
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null
  });
  return destination;
}

const destinationPublicSelect = {
  id: true,
  name: true,
  type: true,
  enabled: true,
  urlMasked: true,
  minSeverity: true,
  eventTypes: true,
  scopeNodeIds: true,
  scopeWorkloadIds: true,
  consecutiveFailures: true,
  lastDeliveryStatus: true,
  lastDeliveryAt: true,
  lastSuccessAt: true,
  createdAt: true,
  updatedAt: true
} satisfies Prisma.NotificationDestinationSelect;

export async function listNotificationDestinations() {
  return prisma.notificationDestination.findMany({
    orderBy: { name: "asc" },
    select: destinationPublicSelect
  });
}

export async function updateNotificationDestination(input: {
  id: string;
  name?: string;
  url?: string;
  authHeader?: string | null;
  signingSecret?: string;
  enabled?: boolean;
  minSeverity?: AttentionSeverity;
  eventTypes?: NotificationEventType[];
  scopeNodeIds?: string[];
  scopeWorkloadIds?: string[];
  actor: AuthSession;
  sourceIp?: string | null;
}) {
  requireNotificationEncryption();
  const existing = await prisma.notificationDestination.findUnique({ where: { id: input.id }, select: { id: true } });
  if (!existing) throw new Error("NOT_FOUND");
  if (input.url) await resolveWebhookTarget(input.url);
  if (input.signingSecret !== undefined && (input.signingSecret.length < 16 || input.signingSecret.length > 1024)) {
    throw new Error("INVALID_SIGNING_SECRET");
  }
  const data: Prisma.NotificationDestinationUpdateInput = {};
  if (input.name !== undefined) data.name = input.name.trim();
  if (input.url !== undefined) {
    data.urlEncrypted = encryptSecret(input.url, "NOTIFICATION_DESTINATIONS");
    data.urlMasked = maskWebhookUrl(input.url);
  }
  if (input.authHeader !== undefined) {
    const header = validateAuthHeader(input.authHeader);
    data.authHeaderEncrypted = header ? encryptSecret(header, "NOTIFICATION_DESTINATIONS") : null;
  }
  if (input.signingSecret !== undefined) {
    data.signingSecretEncrypted = encryptSecret(input.signingSecret, "NOTIFICATION_DESTINATIONS");
  }
  if (input.enabled !== undefined) data.enabled = input.enabled;
  if (input.minSeverity !== undefined) data.minSeverity = input.minSeverity;
  if (input.eventTypes !== undefined) data.eventTypes = Array.from(new Set(input.eventTypes));
  if (input.scopeNodeIds !== undefined) data.scopeNodeIds = Array.from(new Set(input.scopeNodeIds));
  if (input.scopeWorkloadIds !== undefined) data.scopeWorkloadIds = Array.from(new Set(input.scopeWorkloadIds));
  const destination = await prisma.notificationDestination.update({
    where: { id: input.id },
    data,
    select: destinationPublicSelect
  });
  await logAuditEvent({
    actorUserId: input.actor.userId,
    actorEmail: input.actor.email,
    actorRole: input.actor.role,
    action: destination.enabled ? "NOTIFICATION_DESTINATION_UPDATED" : "NOTIFICATION_DESTINATION_DISABLED",
    targetType: "NOTIFICATION_DESTINATION",
    targetId: destination.id,
    metadata: { name: destination.name, enabled: destination.enabled },
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null
  });
  return destination;
}

function retryDelayMs(failedAttemptNumber: number): number | null {
  if (failedAttemptNumber === 1) return Number(process.env.NOTIFICATION_RETRY_DELAY_2_MS ?? 10_000);
  if (failedAttemptNumber === 2) return Number(process.env.NOTIFICATION_RETRY_DELAY_3_MS ?? 60_000);
  return null;
}

function sanitizedDeliveryError(error: unknown, httpStatus?: number): string {
  if (httpStatus) return `HTTP_${httpStatus}`;
  const known = error instanceof Error ? error.message : "WEBHOOK_DELIVERY_FAILED";
  const allow = new Set([
    "WEBHOOK_TIMEOUT",
    "WEBHOOK_CONNECTION_FAILED",
    "WEBHOOK_TARGET_BLOCKED",
    "WEBHOOK_DNS_EMPTY",
    "WEBHOOK_URL_INVALID",
    "WEBHOOK_URL_PROTOCOL",
    "WEBHOOK_URL_CREDENTIALS_FORBIDDEN",
    "WEBHOOK_URL_FRAGMENT_FORBIDDEN"
  ]);
  return allow.has(known) ? known : "WEBHOOK_DELIVERY_FAILED";
}

export async function executeNotificationDelivery(deliveryId: string): Promise<void> {
  const claimed = await prisma.notificationDelivery.updateMany({
    where: { id: deliveryId, status: "PENDING" },
    data: { status: "PROCESSING", startedAt: new Date() }
  });
  if (claimed.count === 0) return;
  const delivery = await prisma.notificationDelivery.findUnique({
    where: { id: deliveryId },
    include: { notificationEvent: true, destination: true }
  });
  if (!delivery) return;
  if (!delivery.destination.enabled) {
    await prisma.notificationDelivery.update({
      where: { id: delivery.id },
      data: { status: "SUPPRESSED", error: "DESTINATION_DISABLED", respondedAt: new Date() }
    });
    return;
  }

  const body = JSON.stringify(delivery.notificationEvent.payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  try {
    requireNotificationEncryption();
    const signingSecret = decryptSecret(delivery.destination.signingSecretEncrypted, "NOTIFICATION_DESTINATIONS");
    const signature = crypto.createHmac("sha256", signingSecret).update(`${timestamp}.${body}`).digest("hex");
    const authHeader = delivery.destination.authHeaderEncrypted
      ? decryptSecret(delivery.destination.authHeaderEncrypted, "NOTIFICATION_DESTINATIONS")
      : null;
    const response = await postWebhook({
      url: decryptSecret(delivery.destination.urlEncrypted, "NOTIFICATION_DESTINATIONS"),
      body,
      headers: {
        "X-HostPanel-Event-Id": delivery.notificationEvent.id,
        "X-HostPanel-Timestamp": timestamp,
        "X-HostPanel-Signature": `sha256=${signature}`,
        ...(delivery.isTest ? { "X-HostPanel-Test": "true" } : {}),
        ...(authHeader ? { Authorization: authHeader } : {})
      }
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw Object.assign(new Error("WEBHOOK_HTTP_FAILURE"), { httpStatus: response.statusCode });
    }
    const respondedAt = new Date();
    await prisma.$transaction([
      prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: { status: "DELIVERED", httpStatus: response.statusCode, error: null, respondedAt, nextRetryAt: null }
      }),
      prisma.notificationDestination.update({
        where: { id: delivery.destinationId },
        data: {
          consecutiveFailures: 0,
          lastDeliveryStatus: "DELIVERED",
          lastDeliveryAt: respondedAt,
          lastSuccessAt: respondedAt
        }
      })
    ]);
  } catch (error) {
    const httpStatus = typeof (error as { httpStatus?: unknown })?.httpStatus === "number"
      ? (error as { httpStatus: number }).httpStatus
      : undefined;
    const respondedAt = new Date();
    const delay = delivery.isManualRetry ? null : retryDelayMs(delivery.attemptNumber);
    await prisma.$transaction([
      prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: {
          status: "FAILED",
          httpStatus: httpStatus ?? null,
          error: sanitizedDeliveryError(error, httpStatus),
          respondedAt,
          nextRetryAt: delay === null ? null : new Date(respondedAt.getTime() + delay)
        }
      }),
      prisma.notificationDestination.update({
        where: { id: delivery.destinationId },
        data: {
          consecutiveFailures: { increment: 1 },
          lastDeliveryStatus: "FAILED",
          lastDeliveryAt: respondedAt
        }
      })
    ]);
  }
}

export async function enqueueDueNotificationRetries(now = new Date()): Promise<number> {
  const due = await prisma.notificationDelivery.findMany({
    where: {
      status: "FAILED",
      isManualRetry: false,
      nextRetryAt: { lte: now },
      attemptNumber: { lt: MAX_DELIVERY_ATTEMPTS }
    },
    orderBy: { nextRetryAt: "asc" },
    take: 50
  });
  let created = 0;
  for (const failed of due) {
    try {
      await prisma.$transaction([
        prisma.notificationDelivery.create({
          data: {
            notificationEventId: failed.notificationEventId,
            destinationId: failed.destinationId,
            attemptNumber: failed.attemptNumber + 1,
            isTest: failed.isTest,
            status: "PENDING"
          }
        }),
        prisma.notificationDelivery.update({ where: { id: failed.id }, data: { nextRetryAt: null } })
      ]);
      created += 1;
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
      await prisma.notificationDelivery.update({ where: { id: failed.id }, data: { nextRetryAt: null } });
    }
  }
  return created;
}

export async function processPendingNotificationDeliveries(limit = 20): Promise<number> {
  const pending = await prisma.notificationDelivery.findMany({
    where: { status: "PENDING" },
    orderBy: { requestedAt: "asc" },
    take: limit,
    select: { id: true }
  });
  for (const delivery of pending) await executeNotificationDelivery(delivery.id);
  return pending.length;
}

export async function recoverInterruptedNotificationDeliveries(now = new Date()): Promise<number> {
  const staleBefore = new Date(now.getTime() - Number(process.env.NOTIFICATION_PROCESSING_STALE_MS ?? 120_000));
  const stale = await prisma.notificationDelivery.findMany({
    where: { status: "PROCESSING", startedAt: { lt: staleBefore } },
    select: { id: true, attemptNumber: true, isManualRetry: true }
  });
  for (const delivery of stale) {
    const delay = delivery.isManualRetry ? null : retryDelayMs(delivery.attemptNumber);
    await prisma.notificationDelivery.update({
      where: { id: delivery.id },
      data: {
        status: "FAILED",
        error: "WORKER_INTERRUPTED",
        respondedAt: now,
        nextRetryAt: delay === null ? null : now
      }
    });
  }
  return stale.length;
}

export async function sendTestNotification(input: {
  destinationId: string;
  actor: AuthSession;
  sourceIp?: string | null;
}) {
  const destination = await prisma.notificationDestination.findUnique({ where: { id: input.destinationId } });
  if (!destination) throw new Error("NOT_FOUND");
  const id = crypto.randomUUID();
  const payload = {
    schemaVersion: 1,
    eventId: id,
    event: "TEST_NOTIFICATION",
    severity: "INFO",
    summary: "Noderaft test notification",
    detail: "This test does not represent an operational condition.",
    url: publicBaseUrl().toString()
  };
  const event = await prisma.notificationEvent.create({
    data: {
      id,
      dedupeKey: `test:${id}`,
      type: "TEST_NOTIFICATION",
      severity: "INFO",
      summary: "Noderaft test notification",
      payload
    }
  });
  const delivery = await prisma.notificationDelivery.create({
    data: {
      notificationEventId: event.id,
      destinationId: destination.id,
      attemptNumber: 1,
      status: destination.enabled ? "PENDING" : "SUPPRESSED",
      error: destination.enabled ? null : "DESTINATION_DISABLED",
      isTest: true
    }
  });
  if (destination.enabled) await executeNotificationDelivery(delivery.id);
  const result = await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
  await logAuditEvent({
    actorUserId: input.actor.userId,
    actorEmail: input.actor.email,
    actorRole: input.actor.role,
    action: "NOTIFICATION_TEST_SENT",
    targetType: "NOTIFICATION_DESTINATION",
    targetId: destination.id,
    metadata: { deliveryId: delivery.id, status: result.status },
    result: result.status === "DELIVERED" ? "SUCCESS" : "FAILURE",
    sourceIp: input.sourceIp ?? null
  });
  return result;
}

export async function retryNotificationDelivery(input: {
  deliveryId: string;
  actor: AuthSession;
  sourceIp?: string | null;
}) {
  const prior = await prisma.notificationDelivery.findUnique({ where: { id: input.deliveryId } });
  if (!prior) throw new Error("NOT_FOUND");
  const aggregate = await prisma.notificationDelivery.aggregate({
    where: { notificationEventId: prior.notificationEventId, destinationId: prior.destinationId },
    _max: { attemptNumber: true }
  });
  const delivery = await prisma.notificationDelivery.create({
    data: {
      notificationEventId: prior.notificationEventId,
      destinationId: prior.destinationId,
      attemptNumber: (aggregate._max.attemptNumber ?? 0) + 1,
      status: "PENDING",
      isTest: prior.isTest,
      isManualRetry: true
    }
  });
  await logAuditEvent({
    actorUserId: input.actor.userId,
    actorEmail: input.actor.email,
    actorRole: input.actor.role,
    action: "NOTIFICATION_DELIVERY_RETRIED",
    targetType: "NOTIFICATION_DELIVERY",
    targetId: delivery.id,
    metadata: { priorDeliveryId: prior.id, notificationEventId: prior.notificationEventId },
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null
  });
  return delivery;
}

export async function listNotificationDeliveries(limit = 100) {
  return prisma.notificationDelivery.findMany({
    orderBy: { requestedAt: "desc" },
    take: Math.min(limit, 200),
    select: {
      id: true,
      attemptNumber: true,
      status: true,
      httpStatus: true,
      error: true,
      isTest: true,
      isManualRetry: true,
      requestedAt: true,
      startedAt: true,
      respondedAt: true,
      notificationEvent: {
        select: { id: true, type: true, severity: true, summary: true, resourceType: true, resourceId: true, occurredAt: true }
      },
      destination: { select: { id: true, name: true, urlMasked: true } }
    }
  });
}

async function statesMatchingScope(input: {
  attentionStateId?: string | null;
  nodeId?: string | null;
  workloadId?: string | null;
}): Promise<NotificationConditionState[]> {
  const states = await prisma.attentionState.findMany({
    where: { resolvedAt: null, severity: { in: ["CRITICAL", "WARNING"] } },
    orderBy: [{ severity: "asc" }, { lastObservedAt: "desc" }]
  });
  const matches: NotificationConditionState[] = [];
  for (const state of states) {
    if (input.attentionStateId && state.id === input.attentionStateId) {
      matches.push(state);
      continue;
    }
    const context = await resolveConditionResourceContext(state);
    if ((input.nodeId && context.nodeId === input.nodeId) || (input.workloadId && context.workloadId === input.workloadId)) {
      matches.push(state);
    }
  }
  return matches.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}

/** Backend-owned expiry/start/end processing. Browser timers are irrelevant. */
export async function sweepNotificationPolicyTransitions(now = new Date()): Promise<void> {
  const [expiredSilences, startingMaintenance, endedMaintenance] = await Promise.all([
    prisma.attentionSilence.findMany({
      where: { cancelledAt: null, endsAt: { lte: now }, expiredNotifiedAt: null },
      orderBy: { endsAt: "asc" },
      take: 50
    }),
    prisma.maintenanceWindow.findMany({
      where: { cancelledAt: null, startsAt: { lte: now }, endsAt: { gt: now }, startedRecordedAt: null },
      orderBy: { startsAt: "asc" },
      take: 50
    }),
    prisma.maintenanceWindow.findMany({
      where: { cancelledAt: null, endsAt: { lte: now }, endedProcessedAt: null },
      orderBy: { endsAt: "asc" },
      take: 50
    })
  ]);

  for (const silence of expiredSilences) {
    const [state] = await statesMatchingScope(silence);
    if (state) {
      await createConditionNotificationEvent({
        state,
        type: "SILENCE_EXPIRED_STILL_ACTIVE",
        dedupeKey: `silence:${silence.id}:expired:${state.id}:${state.firstObservedAt.toISOString()}`,
        occurredAt: now,
        transitionReason: "SILENCE_EXPIRED_STILL_ACTIVE"
      });
    }
    await prisma.attentionSilence.updateMany({
      where: { id: silence.id, expiredNotifiedAt: null },
      data: { expiredNotifiedAt: now }
    });
    await logAuditEvent({
      action: "ATTENTION_SILENCE_EXPIRED",
      targetType: silence.scope,
      targetId: silence.attentionStateId ?? silence.nodeId ?? silence.workloadId,
      metadata: { silenceId: silence.id, stillActiveConditionId: state?.id ?? null },
      result: "SUCCESS"
    }).catch(() => undefined);
  }

  for (const window of startingMaintenance) {
    const changed = await prisma.maintenanceWindow.updateMany({
      where: { id: window.id, startedRecordedAt: null },
      data: { startedRecordedAt: now }
    });
    if (changed.count > 0) {
      await logAuditEvent({
        action: "MAINTENANCE_STARTED",
        targetType: window.scope,
        targetId: window.nodeId ?? window.workloadId,
        metadata: { maintenanceWindowId: window.id, endsAt: window.endsAt.toISOString() },
        result: "SUCCESS"
      }).catch(() => undefined);
    }
  }

  for (const window of endedMaintenance) {
    const [state] = await statesMatchingScope(window);
    if (state && window.notificationBehavior === "SUPPRESS") {
      await createConditionNotificationEvent({
        state,
        type: "CONDITION_OPENED",
        dedupeKey: `maintenance:${window.id}:ended:${state.id}:${state.firstObservedAt.toISOString()}`,
        occurredAt: now,
        transitionReason: "MAINTENANCE_ENDED_STILL_ACTIVE"
      });
    }
    const changed = await prisma.maintenanceWindow.updateMany({
      where: { id: window.id, endedProcessedAt: null },
      data: { endedProcessedAt: now }
    });
    if (changed.count > 0) {
      await logAuditEvent({
        action: "MAINTENANCE_ENDED",
        targetType: window.scope,
        targetId: window.nodeId ?? window.workloadId,
        metadata: { maintenanceWindowId: window.id, stillActiveConditionId: state?.id ?? null },
        result: "SUCCESS"
      }).catch(() => undefined);
    }
  }
}

export async function sweepNotificationSystem(): Promise<void> {
  await recoverInterruptedNotificationDeliveries();
  await sweepNotificationPolicyTransitions();
  await enqueueDueNotificationRetries();
  await processPendingNotificationDeliveries();
}

let workerTimer: ReturnType<typeof setInterval> | null = null;

export function startNotificationWorker(intervalMs = 5_000): void {
  if (workerTimer) return;
  void sweepNotificationSystem().catch((error) => console.error("[Noderaft] notification worker sweep failed", error));
  workerTimer = setInterval(() => {
    void sweepNotificationSystem().catch((error) => console.error("[Noderaft] notification worker sweep failed", error));
  }, intervalMs);
  workerTimer.unref?.();
}
