import { BRAND } from "@/lib/brand";
import type { PlatformMailContent } from "@/server/services/mail";

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    "\"": "&quot;"
  })[character] ?? character);
}

function emailShell(title: string, body: string): string {
  return `<!doctype html><html><body style="margin:0;background:#0b1020;color:#e8edf7;font-family:Arial,sans-serif"><main style="max-width:600px;margin:32px auto;padding:32px;background:#141b2d;border:1px solid #27314b;border-radius:12px"><p style="margin:0 0 24px;font-size:20px;font-weight:700;letter-spacing:.02em">Noderaft</p><h1 style="font-size:24px;margin:0 0 16px">${title}</h1>${body}<p style="margin:28px 0 0;color:#9aa7bf;font-size:13px">${BRAND.platformUrl}</p></main></body></html>`;
}

function activationLink(activationUrl: string): string {
  const raw = process.env.PLATFORM_PUBLIC_BASE_URL ?? BRAND.platformUrl;
  const platformUrl = new URL(raw);
  if (platformUrl.protocol !== "https:") throw new Error("PLATFORM_PUBLIC_BASE_URL_MUST_BE_HTTPS");
  return new URL(activationUrl, platformUrl).toString();
}

export function invitationEmailTemplate(input: {
  to: string;
  displayName: string;
  activationUrl: string;
  activationExpiresAt: string;
}): PlatformMailContent {
  const url = activationLink(input.activationUrl);
  const expires = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(input.activationExpiresAt));
  const name = escapeHtml(input.displayName);
  return {
    to: input.to,
    subject: "You’re invited to Noderaft",
    text: `Hi ${input.displayName},\n\nYou have been invited to Noderaft. Set your password and activate your account:\n${url}\n\nThis link expires ${expires} UTC.`,
    html: emailShell(
      "You’re invited to Noderaft",
      `<p>Hi ${name},</p><p>You have been invited to access Noderaft. Set your password to activate your account.</p><p style="margin:24px 0"><a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 18px;background:#51d6a2;color:#06130e;border-radius:8px;text-decoration:none;font-weight:700">Activate account</a></p><p style="word-break:break-all;color:#9aa7bf">${escapeHtml(url)}</p><p>This link expires ${escapeHtml(expires)} UTC.</p>`
    )
  };
}

export function smtpTestEmailTemplate(to: string): PlatformMailContent {
  return {
    to,
    subject: "Noderaft SMTP test",
    text: "This is a Noderaft SMTP test email. If you received it, email delivery is configured correctly.",
    html: emailShell("SMTP test successful", "<p>This is a Noderaft SMTP test email.</p><p>If you received it, email delivery is configured correctly.</p>")
  };
}
