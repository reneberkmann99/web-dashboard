import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "./helpers/db";
import { resetDatabase } from "./setup";
import { seedWorld, sessionFor } from "./helpers/fixtures";
import { decryptSecret } from "@/server/security/crypto";
import {
  getPlatformEmailSettings,
  sendInvitationEmail,
  sendSmtpTestEmail,
  setMailTransportFactoryForTests,
  updatePlatformEmailSettings
} from "@/server/services/mail";
import { inviteTeamUser } from "@/server/services/client-team";
import { updatePlatformEmailSettingsSchema } from "@/server/validation/admin";

beforeAll(() => {
  resetDatabase();
});

beforeEach(async () => {
  await prisma.platformEmailSettings.deleteMany();
});

afterEach(() => {
  setMailTransportFactoryForTests();
});

function smtpSettings(overrides: Partial<Parameters<typeof updatePlatformEmailSettings>[0]["settings"]> = {}) {
  return {
    enabled: true,
    host: "smtp.example.test",
    port: 587,
    encryption: "STARTTLS" as const,
    username: "smtp-user",
    password: "smtp-password-probe",
    fromName: "Noderaft",
    fromEmail: "platform@noderaft.ee",
    replyTo: "support@noderaft.ee",
    ...overrides
  };
}

async function saveValidSettings() {
  const world = await seedWorld();
  const actor = sessionFor(world.adminA);
  await updatePlatformEmailSettings({ settings: smtpSettings(), actor, sourceIp: null });
  return { world, actor };
}

describe("platform SMTP settings", () => {
  it("validates enabled SMTP configuration before it can be persisted", async () => {
    const world = await seedWorld();
    await expect(updatePlatformEmailSettings({
      settings: smtpSettings({ host: null }),
      actor: sessionFor(world.adminA),
      sourceIp: null
    })).rejects.toThrow("SMTP_CONFIGURATION_INVALID");

    await expect(updatePlatformEmailSettings({
      settings: smtpSettings({ password: undefined }),
      actor: sessionFor(world.adminA),
      sourceIp: null
    })).rejects.toThrow("SMTP_CONFIGURATION_INVALID");

    expect(() => updatePlatformEmailSettingsSchema.parse({
      ...smtpSettings(),
      port: 0
    })).toThrow();
  });

  it("encrypts SMTP passwords and returns only redacted configuration", async () => {
    const { actor } = await saveValidSettings();
    const row = await prisma.platformEmailSettings.findUniqueOrThrow({ where: { id: "default" } });
    expect(row.passwordEncrypted).not.toContain("smtp-password-probe");
    expect(decryptSecret(row.passwordEncrypted!, "SMTP_CREDENTIALS")).toBe("smtp-password-probe");

    const view = await getPlatformEmailSettings();
    expect(view.passwordConfigured).toBe(true);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("smtp-password-probe");
    expect(serialized).not.toContain("passwordEncrypted");

    const audits = await prisma.auditLog.findMany({ where: { targetType: "PLATFORM_EMAIL_SETTINGS" } });
    expect(JSON.stringify(audits)).not.toContain("smtp-password-probe");
    expect(JSON.stringify(audits)).not.toContain("smtp-user");
    expect(actor.role).toBe("ADMIN");
  });

  it("rejects non-platform-admin access", async () => {
    const world = await seedWorld();
    await expect(updatePlatformEmailSettings({
      settings: smtpSettings(),
      actor: sessionFor(world.clientAAdmin),
      sourceIp: null
    })).rejects.toThrow("FORBIDDEN");
    await expect(sendSmtpTestEmail({
      to: "recipient@example.test",
      actor: sessionFor(world.clientAOperator),
      sourceIp: null
    })).rejects.toThrow("FORBIDDEN");
  });

  it("connects, authenticates, and sends a successful SMTP test", async () => {
    const { actor } = await saveValidSettings();
    const verify = vi.fn().mockResolvedValue(true);
    const sendMail = vi.fn().mockResolvedValue({ messageId: "test-message" });
    setMailTransportFactoryForTests(() => ({ verify, sendMail }));

    const result = await sendSmtpTestEmail({ to: "recipient@example.test", actor, sourceIp: null });
    expect(result).toEqual({ status: "SENT", message: "Email sent" });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
      to: "recipient@example.test",
      subject: "Noderaft SMTP test",
      from: { name: "Noderaft", address: "platform@noderaft.ee" }
    }));

    const settings = await getPlatformEmailSettings();
    expect(settings.lastTest).toMatchObject({ status: "SUCCEEDED", summary: "Success" });
    expect(await prisma.auditLog.findFirst({ where: { action: "SMTP_TEST_SUCCEEDED" } })).not.toBeNull();
  });

  it("records failed SMTP authentication without storing or exposing credentials", async () => {
    const { actor } = await saveValidSettings();
    const authFailure = Object.assign(new Error("Invalid login smtp-user smtp-password-probe"), { code: "EAUTH" });
    setMailTransportFactoryForTests(() => ({
      verify: vi.fn().mockRejectedValue(authFailure),
      sendMail: vi.fn()
    }));

    const result = await sendSmtpTestEmail({ to: "recipient@example.test", actor, sourceIp: null });
    expect(result.status).toBe("FAILED");
    expect(result.message).toBe("Authentication failed");
    expect(JSON.stringify(result)).not.toContain("smtp-password-probe");
    expect(JSON.stringify(result)).not.toContain("smtp-user");

    const settings = await getPlatformEmailSettings();
    expect(settings.lastTest).toMatchObject({ status: "FAILED", summary: "Authentication failed" });
    expect(JSON.stringify(settings)).not.toContain("smtp-password-probe");
    // The configured username is intentionally returned to the administrator
    // as an editable setting, but diagnostics never echo it back.
    expect(settings.lastTest?.detail).not.toContain("smtp-user");
    expect(await prisma.auditLog.findFirst({ where: { action: "SMTP_TEST_FAILED", result: "FAILURE" } })).not.toBeNull();
  });

  it("does not attempt SMTP while delivery is disabled", async () => {
    const world = await seedWorld();
    const actor = sessionFor(world.adminA);
    await updatePlatformEmailSettings({
      settings: smtpSettings({ enabled: false, password: undefined, username: null }),
      actor,
      sourceIp: null
    });
    const verify = vi.fn();
    setMailTransportFactoryForTests(() => ({ verify, sendMail: vi.fn() }));

    await expect(sendSmtpTestEmail({ to: "recipient@example.test", actor, sourceIp: null })).resolves.toEqual({
      status: "DISABLED",
      message: "Email delivery is disabled"
    });
    await expect(sendInvitationEmail({
      to: "recipient@example.test",
      displayName: "Recipient",
      activationUrl: "/activate?token=activation-token",
      activationExpiresAt: new Date(Date.now() + 3_600_000).toISOString()
    })).resolves.toEqual({ status: "DISABLED", message: "Email delivery is disabled" });
    expect(verify).not.toHaveBeenCalled();
  });

  it("delivers activation invitations through the canonical SMTP service", async () => {
    const { world } = await saveValidSettings();
    const verify = vi.fn().mockResolvedValue(true);
    const sendMail = vi.fn().mockResolvedValue({ messageId: "invite-message" });
    setMailTransportFactoryForTests(() => ({ verify, sendMail }));

    const invitation = await inviteTeamUser(
      sessionFor(world.clientAAdmin),
      { email: "new-member@example.test", displayName: "New Member", role: "CLIENT_OPERATOR" },
      null
    );
    const result = await sendInvitationEmail({
      to: "new-member@example.test",
      displayName: "New Member",
      activationUrl: invitation.activationUrl,
      activationExpiresAt: invitation.activationExpiresAt
    });

    expect(result.status).toBe("SENT");
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
      to: "new-member@example.test",
      subject: "You’re invited to Noderaft",
      text: expect.stringContaining("https://platform.noderaft.ee/activate?token=")
    }));
  });
});
