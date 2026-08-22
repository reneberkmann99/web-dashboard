import { Role, SmtpEncryption, SmtpTestStatus } from "@prisma/client";
import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { logAuditEvent } from "@/server/audit";
import type { AuthSession } from "@/server/auth/session";
import { prisma } from "@/server/db";
import { decryptSecret, encryptSecret, isEncryptionKeyConfigured } from "@/server/security/crypto";
import { invitationEmailTemplate, smtpTestEmailTemplate } from "@/server/services/mail-templates";

const SETTINGS_ID = "default";

type MailTransport = Pick<ReturnType<typeof nodemailer.createTransport>, "verify" | "sendMail"> & {
  close?: () => void;
};
type MailTransportFactory = (options: SMTPTransport.Options) => MailTransport;

let mailTransportFactory: MailTransportFactory = (options) => nodemailer.createTransport(options);

/** Test-only seam. Application code always uses Nodemailer through this one service. */
export function setMailTransportFactoryForTests(factory?: MailTransportFactory): void {
  mailTransportFactory = factory ?? ((options) => nodemailer.createTransport(options));
}

export type PlatformEmailSettingsView = {
  enabled: boolean;
  host: string | null;
  port: number | null;
  encryption: SmtpEncryption;
  username: string | null;
  passwordConfigured: boolean;
  fromName: string | null;
  fromEmail: string | null;
  replyTo: string | null;
  encryptionReady: boolean;
  lastTest: {
    status: SmtpTestStatus;
    at: string;
    summary: string;
    detail: string | null;
  } | null;
};

export type UpdatePlatformEmailSettingsInput = {
  enabled: boolean;
  host: string | null;
  port: number | null;
  encryption: SmtpEncryption;
  username?: string | null;
  password?: string;
  fromName: string | null;
  fromEmail: string | null;
  replyTo?: string | null;
};

/**
 * Best-effort classification of an EMAIL delivery failure (Phase 4 alerting
 * delivery history: "For Email, classify failures where possible"). Derived
 * from Nodemailer/SMTP error shape — never guaranteed exhaustive, hence
 * UNKNOWN as the fallback rather than a forced guess.
 */
export type EmailFailureClass = "AUTH_FAILURE" | "RECIPIENT_REJECTED" | "TIMEOUT" | "TRANSIENT_SMTP_ERROR" | "UNKNOWN";

export type MailDeliveryResult = {
  status: "SENT" | "DISABLED" | "FAILED";
  message: string;
  detail?: string;
  /** Present only when status is FAILED. */
  classification?: EmailFailureClass;
};

type ActiveSmtpConfig = {
  host: string;
  port: number;
  encryption: SmtpEncryption;
  username: string | null;
  password: string | null;
  fromName: string;
  fromEmail: string;
  replyTo: string | null;
};

export type PlatformMailContent = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

export class PlatformEmailSettingsError extends Error {
  constructor(
    public readonly code: "FORBIDDEN" | "SMTP_ENCRYPTION_NOT_CONFIGURED" | "SMTP_CONFIGURATION_INVALID" | "SMTP_DISABLED"
  ) {
    super(code);
    this.name = "PlatformEmailSettingsError";
  }
}

function assertPlatformAdmin(session: AuthSession): void {
  if (session.role !== Role.ADMIN) throw new PlatformEmailSettingsError("FORBIDDEN");
}

function cleanOptional(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function viewOf(settings: {
  enabled: boolean;
  host: string | null;
  port: number | null;
  encryption: SmtpEncryption;
  username: string | null;
  passwordEncrypted: string | null;
  fromName: string | null;
  fromEmail: string | null;
  replyTo: string | null;
  lastTestStatus: SmtpTestStatus | null;
  lastTestAt: Date | null;
  lastTestSummary: string | null;
  lastTestDetail: string | null;
}): PlatformEmailSettingsView {
  return {
    enabled: settings.enabled,
    host: settings.host,
    port: settings.port,
    encryption: settings.encryption,
    username: settings.username,
    passwordConfigured: Boolean(settings.passwordEncrypted),
    fromName: settings.fromName,
    fromEmail: settings.fromEmail,
    replyTo: settings.replyTo,
    encryptionReady: isEncryptionKeyConfigured("SMTP_CREDENTIALS"),
    lastTest: settings.lastTestStatus && settings.lastTestAt && settings.lastTestSummary
      ? {
          status: settings.lastTestStatus,
          at: settings.lastTestAt.toISOString(),
          summary: settings.lastTestSummary,
          detail: settings.lastTestDetail
        }
      : null
  };
}

export async function getPlatformEmailSettings(): Promise<PlatformEmailSettingsView> {
  const settings = await prisma.platformEmailSettings.findUnique({ where: { id: SETTINGS_ID } });
  if (!settings) {
    return {
      enabled: false,
      host: null,
      port: null,
      encryption: SmtpEncryption.STARTTLS,
      username: null,
      passwordConfigured: false,
      fromName: null,
      fromEmail: null,
      replyTo: null,
      encryptionReady: isEncryptionKeyConfigured("SMTP_CREDENTIALS"),
      lastTest: null
    };
  }
  return viewOf(settings);
}

function validateEnabledConfiguration(input: {
  enabled: boolean;
  host: string | null;
  port: number | null;
  username: string | null;
  passwordEncrypted: string | null;
  fromName: string | null;
  fromEmail: string | null;
}): void {
  if (!input.enabled) return;
  if (!input.host || !input.port || !input.fromName || !input.fromEmail) {
    throw new PlatformEmailSettingsError("SMTP_CONFIGURATION_INVALID");
  }
  // Noderaft uses authenticated SMTP only. This avoids silently routing
  // platform mail through an unauthenticated relay due to a partial save.
  if (!input.username || !input.passwordEncrypted) {
    throw new PlatformEmailSettingsError("SMTP_CONFIGURATION_INVALID");
  }
}

/**
 * Persists the singleton SMTP config. The password is only accepted as a
 * write-only replacement; plaintext and ciphertext are never returned.
 */
export async function updatePlatformEmailSettings(input: {
  settings: UpdatePlatformEmailSettingsInput;
  actor: AuthSession;
  sourceIp: string | null;
}): Promise<PlatformEmailSettingsView> {
  assertPlatformAdmin(input.actor);
  const existing = await prisma.platformEmailSettings.findUnique({ where: { id: SETTINGS_ID } });
  const host = cleanOptional(input.settings.host);
  const username = cleanOptional(input.settings.username);
  const fromName = cleanOptional(input.settings.fromName);
  const fromEmail = cleanOptional(input.settings.fromEmail);
  const replyTo = cleanOptional(input.settings.replyTo);
  const replacingPassword = Boolean(input.settings.password);

  if (replacingPassword && !isEncryptionKeyConfigured("SMTP_CREDENTIALS")) {
    throw new PlatformEmailSettingsError("SMTP_ENCRYPTION_NOT_CONFIGURED");
  }

  const passwordEncrypted = replacingPassword
    ? encryptSecret(input.settings.password!, "SMTP_CREDENTIALS")
    : existing?.passwordEncrypted ?? null;

  // A stored credential without a username can never be used safely. There is
  // intentionally no plaintext "clear" action; replace it with a valid pair.
  if (!username && passwordEncrypted) {
    throw new PlatformEmailSettingsError("SMTP_CONFIGURATION_INVALID");
  }

  validateEnabledConfiguration({
    enabled: input.settings.enabled,
    host,
    port: input.settings.port,
    username,
    passwordEncrypted,
    fromName,
    fromEmail
  });

  const settings = await prisma.platformEmailSettings.upsert({
    where: { id: SETTINGS_ID },
    create: {
      id: SETTINGS_ID,
      enabled: input.settings.enabled,
      host,
      port: input.settings.port,
      encryption: input.settings.encryption,
      username,
      passwordEncrypted,
      fromName,
      fromEmail,
      replyTo,
      updatedById: input.actor.userId
    },
    update: {
      enabled: input.settings.enabled,
      host,
      port: input.settings.port,
      encryption: input.settings.encryption,
      username,
      passwordEncrypted,
      fromName,
      fromEmail,
      replyTo,
      updatedById: input.actor.userId
    }
  });

  await logAuditEvent({
    actorUserId: input.actor.userId,
    actorEmail: input.actor.email,
    actorRole: input.actor.role,
    action: "EMAIL_SETTINGS_UPDATED",
    targetType: "PLATFORM_EMAIL_SETTINGS",
    targetId: SETTINGS_ID,
    // Username and password/ciphertext are deliberately excluded.
    metadata: {
      enabled: settings.enabled,
      host: settings.host,
      port: settings.port,
      encryption: settings.encryption,
      fromEmail: settings.fromEmail,
      replyTo: settings.replyTo,
      passwordConfigured: Boolean(settings.passwordEncrypted),
      credentialReplaced: replacingPassword
    },
    result: "SUCCESS",
    sourceIp: input.sourceIp
  });

  if (!existing || existing.enabled !== settings.enabled) {
    await logAuditEvent({
      actorUserId: input.actor.userId,
      actorEmail: input.actor.email,
      actorRole: input.actor.role,
      action: settings.enabled ? "EMAIL_DELIVERY_ENABLED" : "EMAIL_DELIVERY_DISABLED",
      targetType: "PLATFORM_EMAIL_SETTINGS",
      targetId: SETTINGS_ID,
      result: "SUCCESS",
      sourceIp: input.sourceIp
    });
  }

  return viewOf(settings);
}

async function getActiveSmtpConfig(): Promise<ActiveSmtpConfig | null> {
  const settings = await prisma.platformEmailSettings.findUnique({ where: { id: SETTINGS_ID } });
  if (!settings || !settings.enabled) return null;

  validateEnabledConfiguration(settings);
  let password: string | null = null;
  if (settings.passwordEncrypted) {
    if (!isEncryptionKeyConfigured("SMTP_CREDENTIALS")) {
      throw new PlatformEmailSettingsError("SMTP_ENCRYPTION_NOT_CONFIGURED");
    }
    password = decryptSecret(settings.passwordEncrypted, "SMTP_CREDENTIALS");
  }

  return {
    host: settings.host!,
    port: settings.port!,
    encryption: settings.encryption,
    username: settings.username,
    password,
    fromName: settings.fromName!,
    fromEmail: settings.fromEmail!,
    replyTo: settings.replyTo
  };
}

function transportOptions(config: ActiveSmtpConfig): SMTPTransport.Options {
  const configuredTimeout = Number(process.env.SMTP_TIMEOUT_MS ?? "10000");
  const timeout = Number.isFinite(configuredTimeout) ? Math.min(Math.max(configuredTimeout, 1_000), 60_000) : 10_000;
  return {
    host: config.host,
    port: config.port,
    secure: config.encryption === SmtpEncryption.TLS,
    requireTLS: config.encryption === SmtpEncryption.STARTTLS,
    auth: config.username && config.password ? { user: config.username, pass: config.password } : undefined,
    connectionTimeout: timeout,
    greetingTimeout: timeout,
    socketTimeout: timeout,
    tls: { rejectUnauthorized: true }
  };
}

function redactSmtpDetail(error: unknown, config: Pick<ActiveSmtpConfig, "username" | "password">): string {
  const raw = error instanceof Error ? error.message : String(error);
  let detail = raw;
  for (const secret of [config.username, config.password]) {
    if (secret) detail = detail.split(secret).join("••••••");
  }
  return detail
    .replace(/((?:password|passwd|pass|username|user|token|auth)\s*[=:]\s*)\S+/gi, "$1••••••")
    .replace(/(smtps?:\/\/[^:\s/@]+:)[^@\s]+@/gi, "$1••••••@")
    .slice(0, 1000);
}

/**
 * Classifies a raw SMTP/Nodemailer error into one of the buckets the
 * alerting delivery history surfaces. `responseCode` follows RFC 5321: 4xx is
 * a transient failure (worth an automatic retry), 5xx is permanent — a
 * rejected recipient in particular is almost always 550/553 with "EENVELOPE".
 */
function classifyEmailError(error: unknown): EmailFailureClass {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
  const responseCode = error && typeof error === "object" && "responseCode" in error && typeof (error as { responseCode: unknown }).responseCode === "number"
    ? (error as { responseCode: number }).responseCode
    : null;
  const message = error instanceof Error ? error.message : String(error);
  if (code === "EAUTH" || /auth(?:entication)?|login/i.test(message)) return "AUTH_FAILURE";
  // The response code range is authoritative when present (RFC 5321: 4xx is
  // transient, 5xx is permanent) — checked before the EENVELOPE/message
  // heuristics below, since an envelope-level 4xx (e.g. a greylisting 451)
  // must classify as transient, not as a permanently rejected recipient.
  if (responseCode !== null && responseCode >= 400 && responseCode < 500) return "TRANSIENT_SMTP_ERROR";
  if (
    (responseCode !== null && responseCode >= 550 && responseCode < 560) ||
    code === "EENVELOPE" ||
    /recipient|mailbox|user unknown/i.test(message)
  ) {
    return "RECIPIENT_REJECTED";
  }
  if (code === "ETIMEDOUT" || /timed?\s?out/i.test(message)) return "TIMEOUT";
  if (code === "ECONNREFUSED" || code === "ECONNECTION" || code === "EDNS") {
    return "TRANSIENT_SMTP_ERROR";
  }
  return "UNKNOWN";
}

function failureFor(error: unknown, config: Pick<ActiveSmtpConfig, "username" | "password">): MailDeliveryResult {
  const detail = redactSmtpDetail(error, config);
  const classification = classifyEmailError(error);
  const message: Record<EmailFailureClass, string> = {
    AUTH_FAILURE: "Authentication failed",
    RECIPIENT_REJECTED: "Recipient rejected",
    TIMEOUT: "Could not connect to SMTP server",
    TRANSIENT_SMTP_ERROR: "Could not connect to SMTP server",
    UNKNOWN: "SMTP delivery failed"
  };
  return { status: "FAILED", message: message[classification], detail, classification };
}

/**
 * The only SMTP transport entry point. Invitations use it today; future
 * account/security and alerting mail must use this function rather than
 * constructing their own Nodemailer transport.
 */
export async function sendPlatformEmail(content: PlatformMailContent): Promise<MailDeliveryResult> {
  const config = await getActiveSmtpConfig();
  if (!config) return { status: "DISABLED", message: "Email delivery is disabled" };

  const transport = mailTransportFactory(transportOptions(config));
  try {
    // verify() makes the test flow prove DNS/connect/TLS/auth before sendMail
    // writes a real message. Invitation delivery follows the same transport.
    await transport.verify();
    await transport.sendMail({
      from: { name: config.fromName, address: config.fromEmail },
      to: content.to,
      replyTo: config.replyTo ?? undefined,
      subject: content.subject,
      text: content.text,
      html: content.html
    });
    return { status: "SENT", message: "Email sent" };
  } catch (error) {
    return failureFor(error, config);
  } finally {
    transport.close?.();
  }
}

/** Canonical invitation mail path used by all platform and organization invites. */
export async function sendInvitationEmail(input: {
  to: string;
  displayName: string;
  activationUrl: string;
  activationExpiresAt: string;
}): Promise<MailDeliveryResult> {
  try {
    return sendPlatformEmail(invitationEmailTemplate(input));
  } catch {
    // A mail fault must never undo a successfully-created invitation. The
    // caller retains the manual/copy activation-link path.
    return { status: "FAILED", message: "Email delivery failed" };
  }
}

/** Sends a real SMTP test message and persists a redacted status for the UI. */
export async function sendSmtpTestEmail(input: {
  to: string;
  actor: AuthSession;
  sourceIp: string | null;
}): Promise<MailDeliveryResult> {
  assertPlatformAdmin(input.actor);
  let result: MailDeliveryResult;
  try {
    result = await sendPlatformEmail(smtpTestEmailTemplate(input.to));
  } catch (error) {
    if (error instanceof PlatformEmailSettingsError && error.code === "SMTP_DISABLED") {
      result = { status: "DISABLED", message: "Email delivery is disabled" };
    } else if (error instanceof PlatformEmailSettingsError) {
      result = { status: "FAILED", message: "SMTP configuration is unavailable" };
    } else {
      result = { status: "FAILED", message: "SMTP delivery failed" };
    }
  }

  if (result.status === "DISABLED") return result;

  const succeeded = result.status === "SENT";
  await prisma.platformEmailSettings.update({
    where: { id: SETTINGS_ID },
    data: {
      lastTestStatus: succeeded ? SmtpTestStatus.SUCCEEDED : SmtpTestStatus.FAILED,
      lastTestAt: new Date(),
      lastTestSummary: succeeded ? "Success" : result.message,
      lastTestDetail: succeeded ? null : result.detail ?? null
    }
  });
  await logAuditEvent({
    actorUserId: input.actor.userId,
    actorEmail: input.actor.email,
    actorRole: input.actor.role,
    action: succeeded ? "SMTP_TEST_SUCCEEDED" : "SMTP_TEST_FAILED",
    targetType: "PLATFORM_EMAIL_SETTINGS",
    targetId: SETTINGS_ID,
    result: succeeded ? "SUCCESS" : "FAILURE",
    sourceIp: input.sourceIp
  });
  return result;
}
