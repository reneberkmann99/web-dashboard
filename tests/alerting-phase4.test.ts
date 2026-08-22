import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "./helpers/db";
import { resetDatabase } from "./setup";
import { seedWorld, sessionFor } from "./helpers/fixtures";
import {
  AlertingForbiddenError,
  createConditionNotificationEvent,
  createDeploymentNotificationEvent,
  createNotificationDestination,
  createNotificationRule,
  executeNotificationDelivery,
  listNotificationDeliveries,
  listNotificationDestinations,
  listNotificationRules,
  sendTestNotification,
  updateNotificationDestination,
  updateNotificationRule
} from "@/server/services/notifications";
import { setMailTransportFactoryForTests, updatePlatformEmailSettings } from "@/server/services/mail";
import { createAttentionSilence, scheduleMaintenance } from "@/server/services/attention-lifecycle";
import { syncAttentionState } from "@/server/services/attention";

let world: Awaited<ReturnType<typeof seedWorld>>;

beforeAll(async () => {
  resetDatabase();
  world = await seedWorld();
});

// SMTP settings are a platform-wide singleton, not per-test isolated —
// without this, an earlier test's enableSmtp() would leak "enabled" into a
// later test that specifically wants delivery off.
beforeEach(async () => {
  await prisma.platformEmailSettings.deleteMany();
});

afterEach(() => {
  setMailTransportFactoryForTests();
});

async function enableSmtp() {
  await updatePlatformEmailSettings({
    settings: {
      enabled: true,
      host: "smtp.example.test",
      port: 587,
      encryption: "STARTTLS",
      username: "smtp-user",
      password: "smtp-password-probe",
      fromName: "Noderaft",
      fromEmail: "platform@noderaft.ee",
      replyTo: null
    },
    actor: sessionFor(world.adminA),
    sourceIp: null
  });
}

// Uses the real attention pipeline (not a bare fixture row) so the condition
// resolves nodeId/workloadId/clientAccountId exactly like production. Creates
// a fresh Container per call (rather than reusing world.web across tests) so
// each test's "opened" transition is genuinely new — AttentionState is keyed
// by (resourceType, resourceId, conditionType), so reusing one resourceId
// across tests would make every call after the first a no-op "still active"
// refresh instead of a new CONDITION_OPENED event.
async function syncContainerCondition(severity: "WARNING" | "CRITICAL", suffix: string): Promise<string> {
  const dockerContainerId = `alert-${suffix}`.replace(/[^a-z0-9-]/gi, "").slice(0, 32);
  await prisma.container.create({
    data: {
      nodeId: world.node1.id,
      dockerContainerId,
      dockerName: `alert-${suffix}`,
      image: "busybox",
      lastKnownStatus: "running",
      isActive: true,
      projectId: world.projectA.id
    }
  });
  const resourceId = `${world.node1.id}:${dockerContainerId}`;
  await syncAttentionState([{
    resourceType: "CONTAINER",
    resourceId,
    conditionType: "CONTAINER_UNHEALTHY",
    severity: severity.toLowerCase() as "warning" | "critical",
    title: `container unhealthy ${suffix}`,
    detail: severity,
    nodeId: world.node1.id
  }]);
  return resourceId;
}

describe("Phase 4 alerting: email delivery", () => {
  it("delivers a formatted alert email with severity/resource/organization/timestamp/deep-link and no secrets", async () => {
    await enableSmtp();
    const sendMail = vi.fn().mockResolvedValue({ messageId: "alert-1" });
    setMailTransportFactoryForTests(() => ({ verify: vi.fn().mockResolvedValue(true), sendMail }));

    const destination = await createNotificationDestination({
      type: "EMAIL",
      name: "Ops inbox",
      emailRecipients: ["ops@example.test", "oncall@example.test"],
      actor: sessionFor(world.adminA)
    });
    await createNotificationRule({
      name: "Critical email",
      scope: "PLATFORM",
      eventTypes: ["CONDITION_OPENED"],
      minSeverity: "CRITICAL",
      destinationId: destination.id,
      actor: sessionFor(world.adminA)
    });

    const suffix = `email-${Date.now()}`;
    const resourceId = await syncContainerCondition("CRITICAL", suffix);
    const event = await prisma.notificationEvent.findFirstOrThrow({ where: { type: "CONDITION_OPENED", resourceId } });
    const delivery = await prisma.notificationDelivery.findFirstOrThrow({ where: { notificationEventId: event.id, destinationId: destination.id } });
    await executeNotificationDelivery(delivery.id);

    expect(sendMail).toHaveBeenCalledTimes(1);
    const sent = sendMail.mock.calls[0][0];
    expect(sent.to).toBe("ops@example.test, oncall@example.test");
    expect(sent.subject).toMatch(/^\[Noderaft\] CRITICAL — /);
    expect(sent.text).toContain("CRITICAL");
    expect(sent.text).toContain(world.clientA.name);
    expect(sent.html).toContain(world.clientA.name);
    expect(sent.html).toMatch(/https:\/\/hostpanel\.test/);
    // No signing secret, SMTP password, or API key material anywhere in the email content.
    expect(JSON.stringify(sent)).not.toContain("smtp-password-probe");

    const updated = await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(updated.status).toBe("DELIVERED");
    expect(updated.emailFailureClass).toBeNull();
  });

  it("classifies an authentication failure", async () => {
    await enableSmtp();
    const authFailure = Object.assign(new Error("Invalid login"), { code: "EAUTH" });
    setMailTransportFactoryForTests(() => ({ verify: vi.fn().mockRejectedValue(authFailure), sendMail: vi.fn() }));
    const destination = await createNotificationDestination({ type: "EMAIL", name: "Auth-fail inbox", emailRecipients: ["a@example.test"], actor: sessionFor(world.adminA) });
    const delivery = await sendTestNotification({ destinationId: destination.id, actor: sessionFor(world.adminA) });
    expect(delivery.status).toBe("FAILED");
    expect(delivery.emailFailureClass).toBe("AUTH_FAILURE");
  });

  it("classifies a rejected recipient", async () => {
    await enableSmtp();
    const rejected = Object.assign(new Error("550 5.1.1 mailbox unavailable"), { code: "EENVELOPE", responseCode: 550 });
    setMailTransportFactoryForTests(() => ({ verify: vi.fn().mockResolvedValue(true), sendMail: vi.fn().mockRejectedValue(rejected) }));
    const destination = await createNotificationDestination({ type: "EMAIL", name: "Rejected inbox", emailRecipients: ["bad@example.test"], actor: sessionFor(world.adminA) });
    const delivery = await sendTestNotification({ destinationId: destination.id, actor: sessionFor(world.adminA) });
    expect(delivery.status).toBe("FAILED");
    expect(delivery.emailFailureClass).toBe("RECIPIENT_REJECTED");
  });

  it("classifies a timeout", async () => {
    await enableSmtp();
    const timeout = Object.assign(new Error("Connection timed out"), { code: "ETIMEDOUT" });
    setMailTransportFactoryForTests(() => ({ verify: vi.fn().mockRejectedValue(timeout), sendMail: vi.fn() }));
    const destination = await createNotificationDestination({ type: "EMAIL", name: "Timeout inbox", emailRecipients: ["c@example.test"], actor: sessionFor(world.adminA) });
    const delivery = await sendTestNotification({ destinationId: destination.id, actor: sessionFor(world.adminA) });
    expect(delivery.status).toBe("FAILED");
    expect(delivery.emailFailureClass).toBe("TIMEOUT");
  });

  it("classifies a transient SMTP error (4xx)", async () => {
    await enableSmtp();
    const transient = Object.assign(new Error("451 4.3.0 try again later"), { code: "EENVELOPE", responseCode: 451 });
    setMailTransportFactoryForTests(() => ({ verify: vi.fn().mockResolvedValue(true), sendMail: vi.fn().mockRejectedValue(transient) }));
    const destination = await createNotificationDestination({ type: "EMAIL", name: "Transient inbox", emailRecipients: ["d@example.test"], actor: sessionFor(world.adminA) });
    const delivery = await sendTestNotification({ destinationId: destination.id, actor: sessionFor(world.adminA) });
    expect(delivery.status).toBe("FAILED");
    expect(delivery.emailFailureClass).toBe("TRANSIENT_SMTP_ERROR");
  });

  it("SMTP disabled suppresses rather than fails an email delivery", async () => {
    // No enableSmtp() call — email delivery is off platform-wide.
    const destination = await createNotificationDestination({ type: "EMAIL", name: "Disabled-smtp inbox", emailRecipients: ["e@example.test"], actor: sessionFor(world.adminA) });
    const delivery = await sendTestNotification({ destinationId: destination.id, actor: sessionFor(world.adminA) });
    expect(delivery.status).toBe("SUPPRESSED");
    expect(delivery.error).toBe("SMTP_NOT_CONFIGURED");
  });
});

describe("Phase 4 alerting: organization scoping and tenant isolation", () => {
  it("an ORGANIZATION-scope rule only matches events resolved to that same organization", async () => {
    const destination = await createNotificationDestination({
      type: "WEBHOOK",
      name: "Org A webhook",
      url: "http://127.0.0.1:1/unused",
      signingSecret: "org-a-signing-secret-1234",
      clientAccountId: world.clientA.id,
      actor: sessionFor(world.adminA)
    });
    await createNotificationRule({
      name: "Org A rule",
      scope: "ORGANIZATION",
      clientAccountId: world.clientA.id,
      eventTypes: ["CONDITION_OPENED"],
      minSeverity: "WARNING",
      destinationId: destination.id,
      actor: sessionFor(world.adminA)
    });

    // A node-level condition has no owning organization -> never matches an ORGANIZATION rule.
    const nodeState = await prisma.attentionState.create({
      data: {
        resourceType: "NODE",
        resourceId: `${world.node1.id}-org-scope-${Date.now()}`,
        conditionType: "NODE_OFFLINE",
        severity: "CRITICAL",
        title: "org-scope node offline",
        detail: "test",
        metadata: { nodeId: world.node1.id }
      }
    });
    await createConditionNotificationEvent({ state: nodeState, type: "CONDITION_OPENED", dedupeKey: `org-scope-node:${nodeState.id}` });
    expect(await prisma.notificationDelivery.count({ where: { destinationId: destination.id, notificationEvent: { resourceId: nodeState.resourceId } } })).toBe(0);

    // A container condition owned by clientA via projectA does match.
    const suffix = `org-scope-${Date.now()}`;
    const resourceId = await syncContainerCondition("CRITICAL", suffix);
    const event = await prisma.notificationEvent.findFirstOrThrow({ where: { type: "CONDITION_OPENED", resourceId }, orderBy: { createdAt: "desc" } });
    expect(event.clientAccountId).toBe(world.clientA.id);
    expect(await prisma.notificationDelivery.count({ where: { destinationId: destination.id, notificationEventId: event.id } })).toBe(1);
  });

  it("a rule cannot be bound to a destination outside its own scope (no cross-organization delivery)", async () => {
    const platformDestination = await createNotificationDestination({ type: "WEBHOOK", name: "Platform hook", url: "http://127.0.0.1:1/unused", signingSecret: "platform-signing-secret-12", actor: sessionFor(world.adminA) });
    const orgADestination = await createNotificationDestination({ type: "WEBHOOK", name: "Org A hook", url: "http://127.0.0.1:1/unused", signingSecret: "org-a-signing-secret-1234", clientAccountId: world.clientA.id, actor: sessionFor(world.adminA) });

    // An ORGANIZATION rule may not point at a platform-owned destination.
    await expect(createNotificationRule({
      name: "bad org rule",
      scope: "ORGANIZATION",
      clientAccountId: world.clientA.id,
      eventTypes: ["CONDITION_OPENED"],
      destinationId: platformDestination.id,
      actor: sessionFor(world.adminA)
    })).rejects.toThrow("DESTINATION_SCOPE_MISMATCH");

    // A PLATFORM rule may not point at an organization-owned destination.
    await expect(createNotificationRule({
      name: "bad platform rule",
      scope: "PLATFORM",
      eventTypes: ["CONDITION_OPENED"],
      destinationId: orgADestination.id,
      actor: sessionFor(world.adminA)
    })).rejects.toThrow("DESTINATION_SCOPE_MISMATCH");

    // Org B's rule may not point at Org A's destination either.
    await expect(createNotificationRule({
      name: "cross-org rule",
      scope: "ORGANIZATION",
      clientAccountId: world.clientB.id,
      eventTypes: ["CONDITION_OPENED"],
      destinationId: orgADestination.id,
      actor: sessionFor(world.adminA)
    })).rejects.toThrow("DESTINATION_SCOPE_MISMATCH");
  });

  it("CLIENT_ADMIN writes are hard-forced onto their own organization regardless of what clientAccountId is sent", async () => {
    const actor = sessionFor(world.clientAAdmin);
    const destination = await createNotificationDestination({
      type: "WEBHOOK",
      name: "Client-created hook",
      url: "http://127.0.0.1:1/unused",
      signingSecret: "client-signing-secret-1234",
      clientAccountId: world.clientB.id, // attempted spoof — must be ignored
      actor
    });
    expect(destination.clientAccountId).toBe(world.clientA.id);

    const rule = await createNotificationRule({
      name: "Client-created rule",
      scope: "PLATFORM", // attempted platform scope — must be rejected
      eventTypes: ["CONDITION_OPENED"],
      destinationId: destination.id,
      actor
    }).catch((error: Error) => error);
    expect(rule).toBeInstanceOf(AlertingForbiddenError);
  });

  it("CLIENT_ADMIN cannot manage another organization's destination or rule", async () => {
    const orgADestination = await createNotificationDestination({ type: "WEBHOOK", name: "Org A only", url: "http://127.0.0.1:1/unused", signingSecret: "org-a-signing-secret-1234", clientAccountId: world.clientA.id, actor: sessionFor(world.adminA) });
    // world.clientBOperator lacks alerting.manage entirely — rejected by the
    // route layer in production; here we confirm the service itself also
    // never allows a non-ADMIN/CLIENT_ADMIN role through (defense in depth).
    await expect(updateNotificationDestination({ id: orgADestination.id, enabled: false, actor: sessionFor(world.clientBOperator) })).rejects.toThrow("FORBIDDEN");
    // A CLIENT_ADMIN for a *different* organization must also be forbidden.
    const clientBAdmin = await prisma.user.create({
      data: { email: `b-admin-${Date.now()}@client-b.local`, displayName: "B Admin", passwordHash: world.password, role: "CLIENT_ADMIN", clientAccountId: world.clientB.id, isActive: true }
    });
    await expect(updateNotificationDestination({ id: orgADestination.id, enabled: false, actor: sessionFor(clientBAdmin) })).rejects.toThrow("FORBIDDEN");
  });

  it("delivery history is tenant-isolated: an organization only sees deliveries through its own destinations", async () => {
    const orgADestination = await createNotificationDestination({ type: "WEBHOOK", name: "Org A history hook", url: "http://127.0.0.1:1/unused", signingSecret: "org-a-signing-secret-1234", clientAccountId: world.clientA.id, actor: sessionFor(world.adminA) });
    await createNotificationRule({ name: "Org A history rule", scope: "ORGANIZATION", clientAccountId: world.clientA.id, eventTypes: ["CONDITION_OPENED"], destinationId: orgADestination.id, actor: sessionFor(world.adminA) });

    const platformDestination = await createNotificationDestination({ type: "WEBHOOK", name: "Platform history hook", url: "http://127.0.0.1:1/unused", signingSecret: "platform-signing-secret-12", actor: sessionFor(world.adminA) });
    await createNotificationRule({ name: "Platform history rule", scope: "PLATFORM", eventTypes: ["CONDITION_OPENED"], destinationId: platformDestination.id, actor: sessionFor(world.adminA) });

    const suffix = `history-${Date.now()}`;
    await syncContainerCondition("CRITICAL", suffix);

    const adminDeliveries = await listNotificationDeliveries(sessionFor(world.adminA), 200);
    const orgADeliveries = await listNotificationDeliveries(sessionFor(world.clientAAdmin), 200);
    const orgAOwnDestinationIds = new Set((await listNotificationDestinations(sessionFor(world.clientAAdmin))).map((d) => d.id));

    expect(adminDeliveries.some((d) => d.destination.id === platformDestination.id)).toBe(true);
    expect(adminDeliveries.some((d) => d.destination.id === orgADestination.id)).toBe(true);
    // Org A's own view includes their own destination's delivery, every
    // delivery it contains belongs to a destination clientA itself owns
    // (other tests in this file also register clientA-scoped destinations,
    // so this isn't necessarily the *only* one) — and never the platform
    // destination's, even though the platform rule also matched their event.
    expect(orgADeliveries.some((d) => d.destination.id === orgADestination.id)).toBe(true);
    expect(orgADeliveries.every((d) => orgAOwnDestinationIds.has(d.destination.id))).toBe(true);
    expect(orgAOwnDestinationIds.has(platformDestination.id)).toBe(false);
  });

  it("listNotificationDestinations / listNotificationRules scope to the caller's own organization for a non-admin actor", async () => {
    await createNotificationDestination({ type: "WEBHOOK", name: "Org B scoped hook", url: "http://127.0.0.1:1/unused", signingSecret: "org-b-signing-secret-1234", clientAccountId: world.clientB.id, actor: sessionFor(world.adminA) });
    const orgADestinations = await listNotificationDestinations(sessionFor(world.clientAAdmin));
    expect(orgADestinations.every((d) => d.clientAccountId === world.clientA.id)).toBe(true);

    const orgARules = await listNotificationRules(sessionFor(world.clientAAdmin));
    expect(orgARules.every((r) => r.clientAccountId === world.clientA.id)).toBe(true);
  });
});

describe("Phase 4 alerting: existing silence/maintenance semantics preserved", () => {
  it("an active silence suppresses delivery without altering the underlying condition", async () => {
    const destination = await createNotificationDestination({ type: "WEBHOOK", name: "Silence-test hook", url: "http://127.0.0.1:1/unused", signingSecret: "silence-signing-secret-1234", actor: sessionFor(world.adminA) });
    await createNotificationRule({ name: "Silence-test rule", scope: "PLATFORM", eventTypes: ["CONDITION_OPENED"], destinationId: destination.id, actor: sessionFor(world.adminA) });

    const state = await prisma.attentionState.create({
      data: { resourceType: "NODE", resourceId: `${world.node1.id}-silence-${Date.now()}`, conditionType: "NODE_OFFLINE", severity: "CRITICAL", title: "silenced node offline", detail: "test", metadata: { nodeId: world.node1.id } }
    });
    await createAttentionSilence({ scope: "CONDITION", attentionStateId: state.id, endsAt: new Date(Date.now() + 3_600_000), actor: sessionFor(world.adminA) });
    const event = await createConditionNotificationEvent({ state, type: "CONDITION_OPENED", dedupeKey: `silence-open:${state.id}` });
    const delivery = await prisma.notificationDelivery.findFirstOrThrow({ where: { notificationEventId: event.eventId, destinationId: destination.id } });
    expect(delivery.status).toBe("SUPPRESSED");
    // The condition itself remains truthful — still active, not resolved.
    expect((await prisma.attentionState.findUniqueOrThrow({ where: { id: state.id } })).resolvedAt).toBeNull();
  });

  it("a SUPPRESS maintenance window suppresses a deployment notification for that workload only", async () => {
    const destination = await createNotificationDestination({ type: "WEBHOOK", name: "Maintenance-test hook", url: "http://127.0.0.1:1/unused", signingSecret: "maint-signing-secret-12345", actor: sessionFor(world.adminA) });
    await createNotificationRule({ name: "Deploy-fail rule", scope: "PLATFORM", eventTypes: ["DEPLOYMENT_FAILED"], destinationId: destination.id, actor: sessionFor(world.adminA) });

    const window = await scheduleMaintenance({
      scope: "WORKLOAD",
      workloadId: world.projectA.id,
      startsAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + 3_600_000),
      notificationBehavior: "SUPPRESS",
      actor: sessionFor(world.adminA)
    });
    expect(window.notificationBehavior).toBe("SUPPRESS");

    const result = await createDeploymentNotificationEvent({
      operationId: `op-suppressed-${Date.now()}`,
      type: "DEPLOYMENT_FAILED",
      projectId: world.projectA.id,
      projectName: world.projectA.name,
      nodeId: world.node1.id,
      nodeName: world.node1.name,
      error: "image pull failed"
    });
    const delivery = await prisma.notificationDelivery.findFirstOrThrow({ where: { notificationEventId: result.eventId, destinationId: destination.id } });
    expect(delivery.status).toBe("SUPPRESSED");
  });
});

describe("Phase 4 alerting: deployment events", () => {
  it("DEPLOYMENT_FAILED reaches a subscribed destination", async () => {
    const destination = await createNotificationDestination({ type: "WEBHOOK", name: "Deploy-fail hook", url: "http://127.0.0.1:1/unused", signingSecret: "deploy-signing-secret-12345", actor: sessionFor(world.adminA) });
    await createNotificationRule({ name: "Deploy-fail rule 2", scope: "PLATFORM", eventTypes: ["DEPLOYMENT_FAILED"], destinationId: destination.id, actor: sessionFor(world.adminA) });
    const result = await createDeploymentNotificationEvent({
      operationId: `op-fail-${Date.now()}`,
      type: "DEPLOYMENT_FAILED",
      projectId: world.projectA.id,
      projectName: world.projectA.name,
      nodeId: world.node1.id,
      nodeName: world.node1.name,
      error: "compose apply failed"
    });
    expect(result.created).toBe(true);
    // Scoped to this test's own destination — other tests in this file also
    // register PLATFORM-scope DEPLOYMENT_FAILED rules against their own
    // destinations, and those legitimately match this same event too.
    expect(await prisma.notificationDelivery.count({ where: { notificationEventId: result.eventId, destinationId: destination.id } })).toBe(1);
    const event = await prisma.notificationEvent.findUniqueOrThrow({ where: { id: result.eventId } });
    expect(event.severity).toBe("CRITICAL");
    expect(event.clientAccountId).toBe(world.clientA.id);
  });

  it("DEPLOYMENT_SUCCEEDED is opt-in: a rule that never listed it receives nothing, one that does receives it", async () => {
    const destination = await createNotificationDestination({ type: "WEBHOOK", name: "Deploy-success hook", url: "http://127.0.0.1:1/unused", signingSecret: "deploy-signing-secret-99999", actor: sessionFor(world.adminA) });
    // Default-style rule: only failures, matching what the UI pre-selects.
    await createNotificationRule({ name: "Failures only", scope: "PLATFORM", eventTypes: ["DEPLOYMENT_FAILED"], destinationId: destination.id, actor: sessionFor(world.adminA) });

    const opId = `op-success-optin-${Date.now()}`;
    const firstResult = await createDeploymentNotificationEvent({
      operationId: opId, type: "DEPLOYMENT_SUCCEEDED", projectId: world.projectA.id, projectName: world.projectA.name, nodeId: world.node1.id, nodeName: world.node1.name
    });
    expect(firstResult.deliveries).toBe(0);

    const optInDestination = await createNotificationDestination({ type: "WEBHOOK", name: "Deploy-success opt-in hook", url: "http://127.0.0.1:1/unused", signingSecret: "deploy-signing-secret-88888", actor: sessionFor(world.adminA) });
    // DEPLOYMENT_SUCCEEDED events carry INFO severity — a rule opting into
    // them must also lower its minSeverity, or the default WARNING threshold
    // filters them out despite the event type matching.
    await createNotificationRule({ name: "Opted in to successes", scope: "PLATFORM", eventTypes: ["DEPLOYMENT_SUCCEEDED"], minSeverity: "INFO", destinationId: optInDestination.id, actor: sessionFor(world.adminA) });
    const opId2 = `op-success-optin2-${Date.now()}`;
    const secondResult = await createDeploymentNotificationEvent({
      operationId: opId2, type: "DEPLOYMENT_SUCCEEDED", projectId: world.projectA.id, projectName: world.projectA.name, nodeId: world.node1.id, nodeName: world.node1.name
    });
    expect(await prisma.notificationDelivery.count({ where: { notificationEventId: secondResult.eventId, destinationId: optInDestination.id } })).toBe(1);
  });

  it("is idempotent per operation (dedupe key includes operationId + type)", async () => {
    const destination = await createNotificationDestination({ type: "WEBHOOK", name: "Deploy-dedupe hook", url: "http://127.0.0.1:1/unused", signingSecret: "deploy-signing-secret-77777", actor: sessionFor(world.adminA) });
    await createNotificationRule({ name: "Dedupe rule", scope: "PLATFORM", eventTypes: ["DEPLOYMENT_FAILED"], destinationId: destination.id, actor: sessionFor(world.adminA) });
    const opId = `op-dedupe-${Date.now()}`;
    const first = await createDeploymentNotificationEvent({ operationId: opId, type: "DEPLOYMENT_FAILED", projectId: world.projectA.id, projectName: world.projectA.name, nodeId: world.node1.id, nodeName: world.node1.name, error: "x" });
    const second = await createDeploymentNotificationEvent({ operationId: opId, type: "DEPLOYMENT_FAILED", projectId: world.projectA.id, projectName: world.projectA.name, nodeId: world.node1.id, nodeName: world.node1.name, error: "x" });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(await prisma.notificationEvent.count({ where: { dedupeKey: `deployment:${opId}:DEPLOYMENT_FAILED` } })).toBe(1);
  });
});

describe("Phase 4 alerting: rule enable/disable and validation", () => {
  it("disabling a rule stops future deliveries without deleting history", async () => {
    const destination = await createNotificationDestination({ type: "WEBHOOK", name: "Toggle hook", url: "http://127.0.0.1:1/unused", signingSecret: "toggle-signing-secret-12345", actor: sessionFor(world.adminA) });
    const rule = await createNotificationRule({ name: "Toggle rule", scope: "PLATFORM", eventTypes: ["CONDITION_OPENED"], destinationId: destination.id, actor: sessionFor(world.adminA) });
    await updateNotificationRule({ id: rule.id, enabled: false, actor: sessionFor(world.adminA) });

    const state = await prisma.attentionState.create({
      data: { resourceType: "NODE", resourceId: `${world.node1.id}-toggle-${Date.now()}`, conditionType: "NODE_OFFLINE", severity: "CRITICAL", title: "toggle node offline", detail: "test", metadata: { nodeId: world.node1.id } }
    });
    await createConditionNotificationEvent({ state, type: "CONDITION_OPENED", dedupeKey: `toggle:${state.id}` });
    expect(await prisma.notificationDelivery.count({ where: { destinationId: destination.id, notificationEvent: { resourceId: state.resourceId } } })).toBe(0);
  });

  it("rejects an empty event type list", async () => {
    const destination = await createNotificationDestination({ type: "WEBHOOK", name: "Validation hook", url: "http://127.0.0.1:1/unused", signingSecret: "validation-signing-secret-1", actor: sessionFor(world.adminA) });
    await expect(createNotificationRule({ name: "Empty events", scope: "PLATFORM", eventTypes: [], destinationId: destination.id, actor: sessionFor(world.adminA) })).rejects.toThrow("EVENT_TYPES_REQUIRED");
  });

  it("rejects invalid email recipients and empty recipient lists", async () => {
    await expect(createNotificationDestination({ type: "EMAIL", name: "Bad email", emailRecipients: ["not-an-email"], actor: sessionFor(world.adminA) })).rejects.toThrow("INVALID_EMAIL_RECIPIENT");
    await expect(createNotificationDestination({ type: "EMAIL", name: "No recipients", emailRecipients: [], actor: sessionFor(world.adminA) })).rejects.toThrow();
  });
});
