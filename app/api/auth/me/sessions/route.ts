import { getCurrentSession, destroyOtherSessions } from "@/server/auth/session";
import { fail, ok, fromError } from "@/server/http";
import { logAuditEvent } from "@/server/audit";
import { getSourceIpFromRequest } from "@/server/request";

/**
 * POST /api/auth/me/sessions — "log out other sessions". Invalidates every
 * session for the current user except the one making the request.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const session = await getCurrentSession();
    if (!session) {
      return fail("UNAUTHORIZED", "Authentication required", 401);
    }
    const sourceIp = getSourceIpFromRequest(request);

    const invalidated = await destroyOtherSessions(session.userId, session.sessionId);

    await logAuditEvent({
      actorUserId: session.userId,
      actorEmail: session.email,
      actorRole: session.role,
      action: "SELF_LOGOUT_OTHER_SESSIONS",
      targetType: "USER",
      targetId: session.userId,
      metadata: { invalidatedSessions: invalidated },
      result: "SUCCESS",
      sourceIp
    });

    return ok({ invalidatedSessions: invalidated });
  } catch (error) {
    return fromError(error);
  }
}
