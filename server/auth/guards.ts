import { redirect } from "next/navigation";
import { Role } from "@prisma/client";
import { getCurrentSession, type AuthSession } from "@/server/auth/session";

/**
 * Security: server-side page/API guards.
 * These are the ONLY source of truth for authorization.
 * Client-side layout separation is for UX only — never rely on it for access control.
 */

export async function requirePageSession(): Promise<AuthSession> {
  const session = await getCurrentSession();
  if (!session) {
    redirect("/login");
  }
  return session;
}

export async function requirePageRole(role: Role): Promise<AuthSession> {
  const session = await requirePageSession();
  if (session.role !== role) {
    redirect(session.role === "ADMIN" ? "/admin" : "/client");
  }
  return session;
}

export async function requireApiSession(): Promise<AuthSession> {
  const session = await getCurrentSession();
  if (!session) {
    throw new Error("UNAUTHORIZED");
  }
  return session;
}

/** Throws FORBIDDEN if the session role is not in the allowed list. */
export function ensureRole(session: AuthSession, allowed: Role[]): void {
  if (!allowed.includes(session.role)) {
    throw new Error("FORBIDDEN");
  }
}

/**
 * Convenience: requires API session + checks role in one call.
 * Reduces boilerplate in route handlers.
 */
export async function requireApiRole(allowed: Role | Role[]): Promise<AuthSession> {
  const session = await requireApiSession();
  const roles = Array.isArray(allowed) ? allowed : [allowed];
  ensureRole(session, roles);
  return session;
}
