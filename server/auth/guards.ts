import { redirect } from "next/navigation";
import { Role } from "@prisma/client";
import { getCurrentSession, type AuthSession } from "@/server/auth/session";

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

export function ensureRole(session: AuthSession, allowed: Role[]): void {
  if (!allowed.includes(session.role)) {
    throw new Error("FORBIDDEN");
  }
}
