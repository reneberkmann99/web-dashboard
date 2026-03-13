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
    secure: process.env.NODE_ENV === "production",
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
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/"
  });
}

export async function destroySessionByToken(rawToken: string): Promise<void> {
  await prisma.session
    .delete({ where: { tokenHash: hashToken(rawToken) } })
    .catch(() => undefined);
}

export function sessionCookieName(): string {
  return SESSION_COOKIE;
}
