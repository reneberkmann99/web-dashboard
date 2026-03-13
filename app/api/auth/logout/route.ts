import { NextRequest } from "next/server";
import { getCurrentSession, clearSessionCookie, destroySessionByToken, sessionCookieName } from "@/server/auth/session";
import { logAuditEvent } from "@/server/audit";
import { ok } from "@/server/http";

export async function POST(request: NextRequest): Promise<Response> {
  const session = await getCurrentSession();
  const rawToken = request.cookies.get(sessionCookieName())?.value;

  if (rawToken) {
    await destroySessionByToken(rawToken);
  }

  if (session) {
    await logAuditEvent({
      actorUserId: session.userId,
      actorEmail: session.email,
      actorRole: session.role,
      action: "LOGOUT",
      targetType: "SESSION",
      targetId: session.sessionId,
      result: "SUCCESS",
      sourceIp: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null
    });
  }

  const response = ok({ success: true });
  clearSessionCookie(response);
  return response;
}
