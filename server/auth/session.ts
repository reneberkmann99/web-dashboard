import crypto from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { Role } from "@prisma/client";
import { prisma } from "@/server/db";

const SESSION_COOKIE = "hostpanel_session";
const DEFAULT_SESSION_TTL_HOURS = 12;

export type AuthSession = {
  sessionId: string;
  userId: string;
  email: string;
  displayName: string;
  role: Role;
  clientAccountId: string | null;
  clientAccountName: string | null;
};

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function getSessionTtlMs(): number {
  const hours = Number(process.env.SESSION_TTL_HOURS ?? DEFAULT_SESSION_TTL_HOURS);
  return Math.max(hours, 1) * 60 * 60 * 1000;
}

export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + getSessionTtlMs());

  await prisma.session.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt
    }
  });

  return { token, expiresAt };
}

export async function getCurrentSession(): Promise<AuthSession | null> {
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE)?.value;

  if (!rawToken) {
    return null;
  }

  const tokenHash = hashToken(rawToken);

  const current = await prisma.session.findUnique({
    where: { tokenHash },
    include: {
      user: {
        include: {
          clientAccount: true
        }
      }
    }
  });

  if (!current || current.expiresAt.getTime() < Date.now() || !current.user.isActive) {
    if (current) {
      await prisma.session.delete({ where: { id: current.id } });
    }
    return null;
  }

  await prisma.session.update({
    where: { id: current.id },
    data: { lastUsedAt: new Date() }
  });

  return {
    sessionId: current.id,
    userId: current.userId,
    email: current.user.email,
    displayName: current.user.displayName,
    role: current.user.role,
    clientAccountId: current.user.clientAccountId,
    clientAccountName: current.user.clientAccount?.name ?? null
  };
}

export function setSessionCookie(response: NextResponse, token: string, expiresAt: Date): void {
  response.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    secure: process.env.COOKIE_SECURE !== undefined
      ? process.env.COOKIE_SECURE === "true"
      : process.env.NODE_ENV === "production",
    sameSite: "lax",
    expires: expiresAt,
    path: "/"
  });
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set({
    name: SESSION_COOKIE,
    value: "",
    expires: new Date(0),
    httpOnly: true,
    secure: process.env.COOKIE_SECURE !== undefined
      ? process.env.COOKIE_SECURE === "true"
      : process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/"
  });
}

export async function destroySessionByToken(rawToken: string): Promise<void> {
  await prisma.session
    .delete({ where: { tokenHash: hashToken(rawToken) } })
    .catch(() => undefined);
}

/**
 * Invalidate every session for a user except the caller's current session
 * (self-service "log out other sessions"). Never deletes the current
 * session row, so the caller stays authenticated.
 */
export async function destroyOtherSessions(userId: string, exceptSessionId: string): Promise<number> {
  const result = await prisma.session.deleteMany({
    where: { userId, id: { not: exceptSessionId } }
  });
  return result.count;
}

export function sessionCookieName(): string {
  return SESSION_COOKIE;
}

export const CSRF_COOKIE = "hostpanel_csrf";

/**
 * Double-submit CSRF token: a non-HttpOnly cookie whose value the frontend
 * mirrors into the X-CSRF-Token header on state-changing requests. The
 * middleware rejects requests where the two differ. SameSite=Lax is set so
 * cross-site top-level POSTs cannot even attach it.
 *
 * The cookie lifetime is tied to the session (via `expiresAt`) so it survives
 * browser restarts for as long as the session does. Without this, the session
 * cookie (persistent, 12h) outlives the CSRF cookie (session-scoped), leaving
 * the browser authenticated but with no CSRF token — every mutation 403s.
 */
export function setCsrfCookie(response: NextResponse, expiresAt?: Date): void {
  const token = crypto.randomBytes(24).toString("hex");
  response.cookies.set({
    name: CSRF_COOKIE,
    value: token,
    httpOnly: false,
    secure: process.env.COOKIE_SECURE !== undefined
      ? process.env.COOKIE_SECURE === "true"
      : process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    ...(expiresAt ? { expires: expiresAt } : {})
  });
}
