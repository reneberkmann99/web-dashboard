import crypto from "node:crypto";
import {
  Prisma,
  type AttentionResourceType,
  type AttentionSeverity,
  type NotificationEventType,
  type NotificationDestinationType,
  type NotificationRuleScope
} from "@prisma/client";
import { prisma } from "@/server/db";
import { logAuditEvent } from "@/server/audit";
import type { AuthSession } from "@/server/auth/session";
import { decryptSecret, encryptSecret, isEncryptionKeyConfigured } from "@/server/security/crypto";
import { postWebhook, resolveWebhookTarget } from "@/server/security/webhook-security";
import { getLifecyclePolicyContext, resolveConditionResourceContext } from "@/server/services/attention-lifecycle";
import { sendPlatformEmail } from "@/server/services/mail";
import { alertEmailTemplate } from "@/server/services/mail-templates";

/**
 * Alerting (Phase 4): notification destinations (WEBHOOK/EMAIL, "where"),
 * routing rules (NotificationRule, "what triggers it" — scope/event
 * types/severity), and delivery (NotificationEvent -> NotificationDelivery,
 * one attempt per matched destination). Builds on the Phase 6E lifecycle
 * model (AttentionSilence/MaintenanceWindow suppression, which this file
 * still owns) without changing that model's semantics: acknowledgement never
 * resolves a condition, silence/maintenance only ever suppress *delivery*,
 * never the underlying AttentionState truth.
 *
 * Tenant isolation is enforced entirely in this file (never trust a
 * client-supplied clientAccountId): every mutating/listing function takes the
 * caller's `actor: AuthSession` and, for a non-ADMIN actor, hard-scopes reads
 * to their own organization and forces writes onto their own
 * `clientAccountId` — the same pattern as server/services/client-team.ts.
 */

const MAX_DELIVERY_ATTEMPTS = 3;
const SEVERITY_RANK: Record<AttentionSeverity, number> = { INFO: 0, WARNING: 1, CRITICAL: 2 };
const MAX_EMAIL_RECIPIENTS = 20;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class AlertingForbiddenError extends Error {
  constructor(message = "FORBIDDEN") {
    super(message);
    this.name = "AlertingForbiddenError";
  }
}

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
  const raw = process.env.HOSTPANEL_PUBLIC_BASE_URL ?? "https://platform.noderaft.ee";
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

async function resolveClientAccountId(workloadId: string | null): Promise<string | null> {
  if (!workloadId) return null;
  const project = await prisma.project.findUnique({ where: { id: workloadId }, select: { clientAccountId: true } });
  return project?.clientAccountId ?? null;
}

async function organizationSummary(clientAccountId: string | null): Promise<{ id: string; name: string } | null> {
  if (!clientAccountId) return null;
  const account = await prisma.clientAccount.findUnique({ where: { id: clientAccountId }, select: { id: true, name: true } });
  return account ? { id: account.id, name: account.name } : null;
}

/**
 * Every enabled destination whose event types + minimum severity match, and
 * whose rule scope is eligible: PLATFORM rules always match, ORGANIZATION
 * rules only match an event resolved to that exact organization. Distinct by
 * destinationId — a destination reachable through more than one matching
 * rule still receives exactly one delivery per event.
 */
async function matchingDestinationIds(input: {
  type: NotificationEventType;
  severity: AttentionSeverity;
  clientAccountId: string | null;
}): Promise<string[]> {
  const rules = await prisma.notificationRule.findMany({
    where: { enabled: true, eventTypes: { has: input.type }, destination: { enabled: true } },
    select: { scope: true, clientAccountId: true, minSeverity: true, destinationId: true }
  });
  const destinationIds = new Set<string>();
  for (const rule of rules) {
    if (rule.scope === "ORGANIZATION" && (!input.clientAccountId || rule.clientAccountId !== input.clientAccountId)) continue;
    if (!destinationAllowsSeverity(rule.minSeverity, input.severity)) continue;
    destinationIds.add(rule.destinationId);
  }
  return [...destinationIds];
}

/**
 * Persist one logical event and its initial destination deliveries. The
 * deterministic dedupe key makes duplicate attention syncs harmless. No
 * outbound HTTP/SMTP occurs here; the notification worker owns delivery.
 */
export async function createConditionNotificationEvent(input: {
  state: NotificationConditionState;
  type: Exclude<NotificationEventType, "TEST_NOTIFICATION" | "DEPLOYMENT_FAILED" | "DEPLOYMENT_SUCCEEDED">;
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
  const clientAccountId = await resolveClientAccountId(context.workloadId);
  const organization = await organizationSummary(clientAccountId);
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
    organization,
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
        nodeId: context.nodeId,
        workloadId: context.workloadId,
        clientAccountId,
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

  const destinationIds = await matchingDestinationIds({ type: input.type, severity: input.state.severity, clientAccountId });
  if (destinationIds.length > 0) {
    await prisma.notificationDelivery.createMany({
      data: destinationIds.map((destinationId) => ({
        notificationEventId: eventId,
        destinationId,
        attemptNumber: 1,
        status: context.notificationsSuppressed ? "SUPPRESSED" : "PENDING",
        error: context.notificationsSuppressed ? "SUPPRESSED_BY_OPERATOR_POLICY" : null,
        respondedAt: context.notificationsSuppressed ? new Date() : null
      })),
      skipDuplicates: true
    });
  }
  return { eventId, created: true, deliveries: destinationIds.length };
}

async function isDeliverySuppressedForWorkload(workloadId: string | null, now = new Date()): Promise<boolean> {
  if (!workloadId) return false;
  const [silence, maintenance] = await Promise.all([
    prisma.attentionSilence.findFirst({
      where: { workloadId, cancelledAt: null, startsAt: { lte: now }, endsAt: { gt: now } },
      select: { id: true }
    }),
    prisma.maintenanceWindow.findFirst({
      where: { workloadId, cancelledAt: null, startsAt: { lte: now }, endsAt: { gt: now }, notificationBehavior: "SUPPRESS" },
      select: { id: true }
    })
  ]);
  return Boolean(silence || maintenance);
}

/**
 * Deployment success/failure (Phase 4 brief: "Deployment failed" event type;
 * successful-deployment notifications are opt-in — no rule includes
 * DEPLOYMENT_SUCCEEDED in its eventTypes by default, so this only reaches a
 * destination an operator explicitly opted in). Reuses the same
 * workload/node-scoped silence + maintenance suppression as attention
 * conditions: a deploy against a workload under an active silence or a
 * SUPPRESS maintenance window is exactly the kind of noise those exist to
 * quiet.
 */
export async function createDeploymentNotificationEvent(input: {
  operationId: string;
  type: "DEPLOYMENT_FAILED" | "DEPLOYMENT_SUCCEEDED";
  projectId: string;
  projectName: string;
  nodeId: string;
  nodeName: string;
  error?: string | null;
  occurredAt?: Date;
}): Promise<{ eventId: string; created: boolean; deliveries: number }> {
  const dedupeKey = `deployment:${input.operationId}:${input.type}`;
  const alreadyExisting = await prisma.notificationEvent.findUnique({ where: { dedupeKey }, select: { id: true } });
  if (alreadyExisting) return { eventId: alreadyExisting.id, created: false, deliveries: 0 };

  const severity: AttentionSeverity = input.type === "DEPLOYMENT_FAILED" ? "CRITICAL" : "INFO";
  const clientAccountId = await resolveClientAccountId(input.projectId);
  const organization = await organizationSummary(clientAccountId);
  const suppressed = await isDeliverySuppressedForWorkload(input.projectId, input.occurredAt ?? new Date());
  const id = crypto.randomUUID();
  const summary = input.type === "DEPLOYMENT_FAILED"
    ? `${input.projectName} deployment failed`
    : `${input.projectName} deployed successfully`;
  const detail = input.type === "DEPLOYMENT_FAILED"
    ? (input.error ? `Deployment failed: ${input.error}` : "Deployment failed.")
    : `Deployment to ${input.nodeName} converged successfully.`;
  const relativeUrl = `/admin/workloads/${encodeURIComponent(input.projectId)}`;
  const payload = {
    schemaVersion: 1,
    eventId: id,
    event: input.type,
    severity,
    resource: { type: "WORKLOAD", id: input.projectId, name: input.projectName },
    node: { id: input.nodeId, name: input.nodeName },
    organization,
    summary,
    detail,
    occurredAt: (input.occurredAt ?? new Date()).toISOString(),
    url: absoluteNoderaftUrl(relativeUrl)
  };

  let eventId: string = id;
  let created = false;
  try {
    await prisma.notificationEvent.create({
      data: {
        id,
        dedupeKey,
        type: input.type,
        severity,
        resourceType: "WORKLOAD",
        resourceId: input.projectId,
        nodeId: input.nodeId,
        workloadId: input.projectId,
        clientAccountId,
        summary,
        payload,
        occurredAt: input.occurredAt ?? new Date()
      }
    });
    created = true;
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
    const existing = await prisma.notificationEvent.findUniqueOrThrow({ where: { dedupeKey } });
    eventId = existing.id;
  }
  if (!created) return { eventId, created: false, deliveries: 0 };

  const destinationIds = await matchingDestinationIds({ type: input.type, severity, clientAccountId });
  if (destinationIds.length > 0) {
    await prisma.notificationDelivery.createMany({
      data: destinationIds.map((destinationId) => ({
        notificationEventId: eventId,
        destinationId,
        attemptNumber: 1,
        status: suppressed ? "SUPPRESSED" : "PENDING",
        error: suppressed ? "SUPPRESSED_BY_OPERATOR_POLICY" : null,
        respondedAt: suppressed ? new Date() : null
      })),
      skipDuplicates: true
    });
  }
  return { eventId, created: true, deliveries: destinationIds.length };
}

// ---------------------------------------------------------------------------
// Tenant scoping helpers
// ---------------------------------------------------------------------------

/**
 * Every alerting mutation/read goes through this — defense in depth alongside
 * the route-level `requireApiCapability("alerting.manage")` check (mirrors
 * client-team.ts's `assertClientAdmin`): only ADMIN and CLIENT_ADMIN may ever
 * reach this service, regardless of what capability check ran upstream, and
 * a CLIENT_ADMIN must actually belong to an organization.
 */
function requireAlertingActor(actor: AuthSession): void {
  if (actor.role === "ADMIN") return;
  if (actor.role !== "CLIENT_ADMIN" || !actor.clientAccountId) throw new AlertingForbiddenError();
}

/** The clientAccountId a LIST query should be scoped to; null means "no scoping" (ADMIN sees everything). */
function tenantScopeFor(actor: AuthSession): string | null {
  return actor.role === "ADMIN" ? null : actor.clientAccountId!;
}

function assertOwnsClientAccountId(actor: AuthSession, ownerId: string | null): void {
  if (actor.role === "ADMIN") return;
  if (ownerId !== actor.clientAccountId) throw new AlertingForbiddenError();
}

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

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

function normalizeEmailRecipients(recipients: string[]): string[] {
  const unique = Array.from(new Set(recipients.map((email) => email.trim().toLowerCase()).filter(Boolean)));
  if (unique.length === 0) throw new Error("EMAIL_RECIPIENTS_REQUIRED");
  if (unique.length > MAX_EMAIL_RECIPIENTS) throw new Error("TOO_MANY_EMAIL_RECIPIENTS");
  for (const email of unique) {
    if (!EMAIL_PATTERN.test(email) || email.length > 254) throw new Error("INVALID_EMAIL_RECIPIENT");
  }
  return unique;
}

function requireNotificationEncryption(): void {
  if (!isEncryptionKeyConfigured("NOTIFICATION_DESTINATIONS")) {
    throw new Error("NOTIFICATION_ENCRYPTION_NOT_CONFIGURED");
  }
}

const destinationPublicSelect = {
  id: true,
  name: true,
  type: true,
  enabled: true,
  clientAccountId: true,
  urlMasked: true,
  emailRecipients: true,
  consecutiveFailures: true,
  lastDeliveryStatus: true,
  lastDeliveryAt: true,
  lastSuccessAt: true,
  createdAt: true,
  updatedAt: true
} satisfies Prisma.NotificationDestinationSelect;

export type CreateDestinationInput = {
  name: string;
  type: NotificationDestinationType;
  enabled?: boolean;
  /** ADMIN only: create an organization-owned destination on that org's behalf. Ignored (forced to actor's own org) for CLIENT_ADMIN. */
  clientAccountId?: string | null;
  // WEBHOOK
  url?: string;
  authHeader?: string | null;
  signingSecret?: string;
  // EMAIL
  emailRecipients?: string[];
  actor: AuthSession;
  sourceIp?: string | null;
};

export async function createNotificationDestination(input: CreateDestinationInput) {
  requireAlertingActor(input.actor);
  const clientAccountId = input.actor.role === "ADMIN" ? (input.clientAccountId ?? null) : input.actor.clientAccountId!;
  if (clientAccountId) {
    const account = await prisma.clientAccount.findUnique({ where: { id: clientAccountId }, select: { id: true } });
    if (!account) throw new Error("NOT_FOUND");
  }

  const name = input.name.trim();
  if (!name) throw new Error("NAME_REQUIRED");

  let data: Prisma.NotificationDestinationCreateInput;
  if (input.type === "WEBHOOK") {
    requireNotificationEncryption();
    if (!input.url) throw new Error("URL_REQUIRED");
    await resolveWebhookTarget(input.url);
    if (!input.signingSecret || input.signingSecret.length < 16 || input.signingSecret.length > 1024) {
      throw new Error("INVALID_SIGNING_SECRET");
    }
    data = {
      name,
      type: "WEBHOOK",
      enabled: input.enabled ?? true,
      clientAccount: clientAccountId ? { connect: { id: clientAccountId } } : undefined,
      urlEncrypted: encryptSecret(input.url, "NOTIFICATION_DESTINATIONS"),
      urlMasked: maskWebhookUrl(input.url),
      authHeaderEncrypted: validateAuthHeader(input.authHeader)
        ? encryptSecret(validateAuthHeader(input.authHeader)!, "NOTIFICATION_DESTINATIONS")
        : null,
      signingSecretEncrypted: encryptSecret(input.signingSecret, "NOTIFICATION_DESTINATIONS"),
      createdBy: { connect: { id: input.actor.userId } }
    };
  } else {
    const recipients = normalizeEmailRecipients(input.emailRecipients ?? []);
    data = {
      name,
      type: "EMAIL",
      enabled: input.enabled ?? true,
      clientAccount: clientAccountId ? { connect: { id: clientAccountId } } : undefined,
      emailRecipients: recipients,
      createdBy: { connect: { id: input.actor.userId } }
    };
  }

  const destination = await prisma.notificationDestination.create({ data, select: destinationPublicSelect });
  await logAuditEvent({
    actorUserId: input.actor.userId,
    actorEmail: input.actor.email,
    actorRole: input.actor.role,
    action: "NOTIFICATION_DESTINATION_CREATED",
    targetType: "NOTIFICATION_DESTINATION",
    targetId: destination.id,
    metadata: { name: destination.name, type: destination.type, enabled: destination.enabled, clientAccountId: destination.clientAccountId },
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null
  });
  return destination;
}

export async function listNotificationDestinations(actor: AuthSession) {
  requireAlertingActor(actor);
  const scope = tenantScopeFor(actor);
  return prisma.notificationDestination.findMany({
    where: scope ? { clientAccountId: scope } : {},
    orderBy: { name: "asc" },
    select: destinationPublicSelect
  });
}

export type UpdateDestinationInput = {
  id: string;
  name?: string;
  enabled?: boolean;
  url?: string;
  authHeader?: string | null;
  signingSecret?: string;
  emailRecipients?: string[];
  actor: AuthSession;
  sourceIp?: string | null;
};

export async function updateNotificationDestination(input: UpdateDestinationInput) {
  requireAlertingActor(input.actor);
  const existing = await prisma.notificationDestination.findUnique({ where: { id: input.id } });
  if (!existing) throw new Error("NOT_FOUND");
  assertOwnsClientAccountId(input.actor, existing.clientAccountId);

  const data: Prisma.NotificationDestinationUpdateInput = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new Error("NAME_REQUIRED");
    data.name = name;
  }
  if (input.enabled !== undefined) data.enabled = input.enabled;

  if (existing.type === "WEBHOOK") {
    if (input.url) {
      requireNotificationEncryption();
      await resolveWebhookTarget(input.url);
      data.urlEncrypted = encryptSecret(input.url, "NOTIFICATION_DESTINATIONS");
      data.urlMasked = maskWebhookUrl(input.url);
    }
    if (input.authHeader !== undefined) {
      const header = validateAuthHeader(input.authHeader);
      data.authHeaderEncrypted = header ? encryptSecret(header, "NOTIFICATION_DESTINATIONS") : null;
    }
    if (input.signingSecret !== undefined) {
      if (input.signingSecret.length < 16 || input.signingSecret.length > 1024) throw new Error("INVALID_SIGNING_SECRET");
      requireNotificationEncryption();
      data.signingSecretEncrypted = encryptSecret(input.signingSecret, "NOTIFICATION_DESTINATIONS");
    }
  } else if (input.emailRecipients !== undefined) {
    data.emailRecipients = normalizeEmailRecipients(input.emailRecipients);
  }

  const destination = await prisma.notificationDestination.update({ where: { id: input.id }, data, select: destinationPublicSelect });
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

export async function deleteNotificationDestination(input: { id: string; actor: AuthSession; sourceIp?: string | null }): Promise<void> {
  requireAlertingActor(input.actor);
  const existing = await prisma.notificationDestination.findUnique({ where: { id: input.id }, select: { id: true, name: true, clientAccountId: true } });
  if (!existing) throw new Error("NOT_FOUND");
  assertOwnsClientAccountId(input.actor, existing.clientAccountId);
  // Cascades to any NotificationRule pointing at it (schema onDelete: Cascade) — a
  // destination with no rules routing to it is otherwise inert, so this is safe.
  await prisma.notificationDestination.delete({ where: { id: input.id } });
  await logAuditEvent({
    actorUserId: input.actor.userId,
    actorEmail: input.actor.email,
    actorRole: input.actor.role,
    action: "NOTIFICATION_DESTINATION_DELETED",
    targetType: "NOTIFICATION_DESTINATION",
    targetId: input.id,
    metadata: { name: existing.name },
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null
  });
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const rulePublicSelect = {
  id: true,
  name: true,
  scope: true,
  clientAccountId: true,
  eventTypes: true,
  minSeverity: true,
  destinationId: true,
  enabled: true,
  createdAt: true,
  updatedAt: true,
  destination: { select: { id: true, name: true, type: true } }
} satisfies Prisma.NotificationRuleSelect;

async function assertDestinationScopeMatch(destinationId: string, scope: NotificationRuleScope, clientAccountId: string | null) {
  const destination = await prisma.notificationDestination.findUnique({ where: { id: destinationId }, select: { id: true, clientAccountId: true } });
  if (!destination) throw new Error("NOT_FOUND");
  if (scope === "PLATFORM" && destination.clientAccountId !== null) throw new Error("DESTINATION_SCOPE_MISMATCH");
  if (scope === "ORGANIZATION" && destination.clientAccountId !== clientAccountId) throw new Error("DESTINATION_SCOPE_MISMATCH");
}

export type CreateRuleInput = {
  name: string;
  scope: NotificationRuleScope;
  /** ADMIN only, required when scope is ORGANIZATION. Ignored (forced to actor's own org) for CLIENT_ADMIN. */
  clientAccountId?: string | null;
  eventTypes: NotificationEventType[];
  minSeverity?: AttentionSeverity;
  destinationId: string;
  enabled?: boolean;
  actor: AuthSession;
  sourceIp?: string | null;
};

export async function createNotificationRule(input: CreateRuleInput) {
  requireAlertingActor(input.actor);
  if (input.actor.role !== "ADMIN" && input.scope !== "ORGANIZATION") {
    // A CLIENT_ADMIN may never create a PLATFORM-scope rule — platform scope
    // sees every organization's events, which is platform-admin oversight only.
    throw new AlertingForbiddenError();
  }
  const clientAccountId = input.scope === "ORGANIZATION"
    ? (input.actor.role === "ADMIN" ? input.clientAccountId ?? null : input.actor.clientAccountId!)
    : null;
  if (input.scope === "ORGANIZATION" && !clientAccountId) throw new Error("ORGANIZATION_SCOPE_REQUIRES_CLIENT");
  if (clientAccountId) {
    const account = await prisma.clientAccount.findUnique({ where: { id: clientAccountId }, select: { id: true } });
    if (!account) throw new Error("NOT_FOUND");
  }
  await assertDestinationScopeMatch(input.destinationId, input.scope, clientAccountId);

  const name = input.name.trim();
  if (!name) throw new Error("NAME_REQUIRED");
  const eventTypes = Array.from(new Set(input.eventTypes));
  if (eventTypes.length === 0) throw new Error("EVENT_TYPES_REQUIRED");

  const rule = await prisma.notificationRule.create({
    data: {
      name,
      scope: input.scope,
      clientAccountId,
      eventTypes,
      minSeverity: input.minSeverity ?? "WARNING",
      destinationId: input.destinationId,
      enabled: input.enabled ?? true,
      createdById: input.actor.userId
    },
    select: rulePublicSelect
  });
  await logAuditEvent({
    actorUserId: input.actor.userId,
    actorEmail: input.actor.email,
    actorRole: input.actor.role,
    action: "NOTIFICATION_RULE_CREATED",
    targetType: "NOTIFICATION_RULE",
    targetId: rule.id,
    metadata: { name: rule.name, scope: rule.scope, clientAccountId: rule.clientAccountId, eventTypes: rule.eventTypes, enabled: rule.enabled },
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null
  });
  return rule;
}

export async function listNotificationRules(actor: AuthSession) {
  requireAlertingActor(actor);
  const scope = tenantScopeFor(actor);
  return prisma.notificationRule.findMany({
    where: scope ? { clientAccountId: scope } : {},
    orderBy: { name: "asc" },
    select: rulePublicSelect
  });
}

export type UpdateRuleInput = {
  id: string;
  name?: string;
  eventTypes?: NotificationEventType[];
  minSeverity?: AttentionSeverity;
  destinationId?: string;
  enabled?: boolean;
  actor: AuthSession;
  sourceIp?: string | null;
};

export async function updateNotificationRule(input: UpdateRuleInput) {
  requireAlertingActor(input.actor);
  const existing = await prisma.notificationRule.findUnique({ where: { id: input.id } });
  if (!existing) throw new Error("NOT_FOUND");
  assertOwnsClientAccountId(input.actor, existing.clientAccountId);

  if (input.destinationId !== undefined) {
    await assertDestinationScopeMatch(input.destinationId, existing.scope, existing.clientAccountId);
  }

  const data: Prisma.NotificationRuleUpdateInput = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new Error("NAME_REQUIRED");
    data.name = name;
  }
  if (input.eventTypes !== undefined) {
    const eventTypes = Array.from(new Set(input.eventTypes));
    if (eventTypes.length === 0) throw new Error("EVENT_TYPES_REQUIRED");
    data.eventTypes = eventTypes;
  }
  if (input.minSeverity !== undefined) data.minSeverity = input.minSeverity;
  if (input.destinationId !== undefined) data.destination = { connect: { id: input.destinationId } };
  if (input.enabled !== undefined) data.enabled = input.enabled;

  const rule = await prisma.notificationRule.update({ where: { id: input.id }, data, select: rulePublicSelect });
  await logAuditEvent({
    actorUserId: input.actor.userId,
    actorEmail: input.actor.email,
    actorRole: input.actor.role,
    action: rule.enabled ? "NOTIFICATION_RULE_UPDATED" : "NOTIFICATION_RULE_DISABLED",
    targetType: "NOTIFICATION_RULE",
    targetId: rule.id,
    metadata: { name: rule.name, enabled: rule.enabled },
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null
  });
  return rule;
}

export async function deleteNotificationRule(input: { id: string; actor: AuthSession; sourceIp?: string | null }): Promise<void> {
  requireAlertingActor(input.actor);
  const existing = await prisma.notificationRule.findUnique({ where: { id: input.id }, select: { id: true, name: true, clientAccountId: true } });
  if (!existing) throw new Error("NOT_FOUND");
  assertOwnsClientAccountId(input.actor, existing.clientAccountId);
  await prisma.notificationRule.delete({ where: { id: input.id } });
  await logAuditEvent({
    actorUserId: input.actor.userId,
    actorEmail: input.actor.email,
    actorRole: input.actor.role,
    action: "NOTIFICATION_RULE_DELETED",
    targetType: "NOTIFICATION_RULE",
    targetId: input.id,
    metadata: { name: existing.name },
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null
  });
}

// ---------------------------------------------------------------------------
// Delivery execution
// ---------------------------------------------------------------------------

function retryDelayMs(failedAttemptNumber: number): number | null {
  if (failedAttemptNumber === 1) return Number(process.env.NOTIFICATION_RETRY_DELAY_2_MS ?? 10_000);
  if (failedAttemptNumber === 2) return Number(process.env.NOTIFICATION_RETRY_DELAY_3_MS ?? 60_000);
  return null;
}

function sanitizedWebhookDeliveryError(error: unknown, httpStatus?: number): string {
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

type DeliveryWithRelations = Prisma.NotificationDeliveryGetPayload<{ include: { notificationEvent: true; destination: true } }>;

async function executeWebhookDelivery(delivery: DeliveryWithRelations): Promise<void> {
  const body = JSON.stringify(delivery.notificationEvent.payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  try {
    requireNotificationEncryption();
    const signingSecret = decryptSecret(delivery.destination.signingSecretEncrypted!, "NOTIFICATION_DESTINATIONS");
    const signature = crypto.createHmac("sha256", signingSecret).update(`${timestamp}.${body}`).digest("hex");
    const authHeader = delivery.destination.authHeaderEncrypted
      ? decryptSecret(delivery.destination.authHeaderEncrypted, "NOTIFICATION_DESTINATIONS")
      : null;
    const response = await postWebhook({
      url: decryptSecret(delivery.destination.urlEncrypted!, "NOTIFICATION_DESTINATIONS"),
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
        data: { consecutiveFailures: 0, lastDeliveryStatus: "DELIVERED", lastDeliveryAt: respondedAt, lastSuccessAt: respondedAt }
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
          error: sanitizedWebhookDeliveryError(error, httpStatus),
          respondedAt,
          nextRetryAt: delay === null ? null : new Date(respondedAt.getTime() + delay)
        }
      }),
      prisma.notificationDestination.update({
        where: { id: delivery.destinationId },
        data: { consecutiveFailures: { increment: 1 }, lastDeliveryStatus: "FAILED", lastDeliveryAt: respondedAt }
      })
    ]);
  }
}

/** Best-effort resource/organization labels pulled from the event's own frozen payload — never re-derived per delivery. */
function payloadField<T>(payload: unknown, key: string): T | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  return (payload as Record<string, unknown>)[key] as T | undefined;
}

async function executeEmailDelivery(delivery: DeliveryWithRelations): Promise<void> {
  const payload = delivery.notificationEvent.payload;
  const resource = payloadField<{ name?: string }>(payload, "resource");
  const organization = payloadField<{ name?: string } | null>(payload, "organization");
  const detail = payloadField<string>(payload, "detail") ?? delivery.notificationEvent.summary;
  const url = payloadField<string | null>(payload, "url") ?? null;
  const content = alertEmailTemplate({
    to: delivery.destination.emailRecipients.join(", "),
    severity: delivery.notificationEvent.severity,
    resourceLabel: resource?.name ?? delivery.notificationEvent.summary,
    organizationName: organization?.name ?? null,
    summary: delivery.notificationEvent.summary,
    detail,
    occurredAt: delivery.notificationEvent.occurredAt.toISOString(),
    url
  });
  const result = await sendPlatformEmail(content);
  const respondedAt = new Date();

  if (result.status === "SENT") {
    await prisma.$transaction([
      prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: { status: "DELIVERED", error: null, emailFailureClass: null, respondedAt, nextRetryAt: null }
      }),
      prisma.notificationDestination.update({
        where: { id: delivery.destinationId },
        data: { consecutiveFailures: 0, lastDeliveryStatus: "DELIVERED", lastDeliveryAt: respondedAt, lastSuccessAt: respondedAt }
      })
    ]);
    return;
  }

  // DISABLED = platform SMTP isn't configured at all — a configuration gap,
  // not this destination's fault, so it's SUPPRESSED (never attempted)
  // rather than FAILED, mirroring a disabled webhook destination.
  const disabled = result.status === "DISABLED";
  const delay = disabled || delivery.isManualRetry ? null : retryDelayMs(delivery.attemptNumber);
  await prisma.$transaction([
    prisma.notificationDelivery.update({
      where: { id: delivery.id },
      data: {
        status: disabled ? "SUPPRESSED" : "FAILED",
        error: disabled ? "SMTP_NOT_CONFIGURED" : (result.classification ?? "UNKNOWN"),
        emailFailureClass: disabled ? null : (result.classification ?? "UNKNOWN"),
        respondedAt,
        nextRetryAt: delay === null ? null : new Date(respondedAt.getTime() + delay)
      }
    }),
    prisma.notificationDestination.update({
      where: { id: delivery.destinationId },
      data: {
        consecutiveFailures: { increment: 1 },
        lastDeliveryStatus: disabled ? "SUPPRESSED" : "FAILED",
        lastDeliveryAt: respondedAt
      }
    })
  ]);
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

  if (delivery.destination.type === "EMAIL") {
    await executeEmailDelivery(delivery);
  } else {
    await executeWebhookDelivery(delivery);
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
  requireAlertingActor(input.actor);
  const destination = await prisma.notificationDestination.findUnique({ where: { id: input.destinationId } });
  if (!destination) throw new Error("NOT_FOUND");
  assertOwnsClientAccountId(input.actor, destination.clientAccountId);
  const id = crypto.randomUUID();
  const payload = {
    schemaVersion: 1,
    eventId: id,
    event: "TEST_NOTIFICATION",
    severity: "INFO",
    resource: { name: "Noderaft test notification" },
    organization: null,
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
  requireAlertingActor(input.actor);
  const prior = await prisma.notificationDelivery.findUnique({
    where: { id: input.deliveryId },
    include: { destination: { select: { clientAccountId: true } } }
  });
  if (!prior) throw new Error("NOT_FOUND");
  assertOwnsClientAccountId(input.actor, prior.destination.clientAccountId);
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

/**
 * Tenant-scoped delivery history: an ADMIN sees every delivery; a
 * CLIENT_ADMIN sees only deliveries through destinations their own
 * organization owns (never a platform-wide destination's deliveries, even
 * for their own organization's events routed there by an ADMIN-owned
 * PLATFORM rule — that destination and its delivery details are platform
 * infrastructure, not this organization's own alerting configuration).
 */
export async function listNotificationDeliveries(actor: AuthSession, limit = 100) {
  requireAlertingActor(actor);
  const scope = tenantScopeFor(actor);
  return prisma.notificationDelivery.findMany({
    where: scope ? { destination: { clientAccountId: scope } } : {},
    orderBy: { requestedAt: "desc" },
    take: Math.min(limit, 200),
    select: {
      id: true,
      attemptNumber: true,
      status: true,
      httpStatus: true,
      error: true,
      emailFailureClass: true,
      isTest: true,
      isManualRetry: true,
      requestedAt: true,
      startedAt: true,
      respondedAt: true,
      notificationEvent: {
        select: { id: true, type: true, severity: true, summary: true, resourceType: true, resourceId: true, occurredAt: true, payload: true }
      },
      destination: { select: { id: true, name: true, type: true, urlMasked: true } }
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
