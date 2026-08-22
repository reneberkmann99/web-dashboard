import { redirect } from "next/navigation";
import { getCurrentSession, type AuthSession } from "@/server/auth/session";
import { isClientRole } from "@/types/domain";
import { ensureCan, type Capability } from "@/server/auth/policy";

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

export async function requirePageRole(role: "ADMIN" | "CLIENT"): Promise<AuthSession> {
  const session = await requirePageSession();
  const isAdminRequest = role === "ADMIN";
  const ok = isAdminRequest ? session.role === "ADMIN" : isClientRole(session.role);
  if (!ok) {
    redirect(session.role === "ADMIN" ? "/admin" : "/organization");
  }
  return session;
}

/** Server-side page guard for capability-scoped organization surfaces. */
export async function requirePageCapability(capability: Capability): Promise<AuthSession> {
  const session = await requirePageSession();
  try {
    ensureCan(session, capability);
  } catch {
    redirect(session.role === "ADMIN" ? "/admin" : "/organization");
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

/** Throws FORBIDDEN if the session lacks the required capability. */
export function requireCapability(session: AuthSession, capability: Capability): void {
  ensureCan(session, capability);
}

/**
 * Convenience: requires API session + capability in one call.
 * Reduces boilerplate in route handlers.
 */
export async function requireApiCapability(capability: Capability): Promise<AuthSession> {
  const session = await requireApiSession();
  ensureCan(session, capability);
  return session;
}

/**
 * Legacy convenience kept for route files not yet migrated to capabilities:
 * requires API session + role membership in the allowed set.
 */
export async function requireApiRole(allowed: "ADMIN" | "CLIENT" | Array<"ADMIN" | "CLIENT">): Promise<AuthSession> {
  const session = await requireApiSession();
  const roles = Array.isArray(allowed) ? allowed : [allowed];
  const clientOk = roles.includes("CLIENT") && isClientRole(session.role);
  const adminOk = roles.includes("ADMIN") && session.role === "ADMIN";
  if (!clientOk && !adminOk) {
    throw new Error("FORBIDDEN");
  }
  return session;
}
