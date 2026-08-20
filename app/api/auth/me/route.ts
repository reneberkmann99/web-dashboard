import { prisma } from "@/server/db";
import { getCurrentSession } from "@/server/auth/session";
import { fail, ok, fromError } from "@/server/http";
import { updateSelfSchema } from "@/server/validation/admin";
import { logAuditEvent } from "@/server/audit";
import { getSourceIpFromRequest } from "@/server/request";

export async function GET(): Promise<Response> {
  const session = await getCurrentSession();
  if (!session) {
    return fail("UNAUTHORIZED", "Authentication required", 401);
  }

  return ok({
    user: {
      id: session.userId,
      email: session.email,
      displayName: session.displayName,
      role: session.role,
      clientAccountId: session.clientAccountId,
      clientAccountName: session.clientAccountName
    }
  });
}

/**
 * PATCH /api/auth/me — self-service profile update (display name only).
 * Role and client membership remain admin-managed and are never settable here.
 */
export async function PATCH(request: Request): Promise<Response> {
  try {
    const session = await getCurrentSession();
    if (!session) {
      return fail("UNAUTHORIZED", "Authentication required", 401);
    }
    const sourceIp = getSourceIpFromRequest(request);

    const body = updateSelfSchema.parse(await request.json());

    await prisma.user.update({
      where: { id: session.userId },
      data: { displayName: body.displayName }
    });

    await logAuditEvent({
      actorUserId: session.userId,
      actorEmail: session.email,
      actorRole: session.role,
      action: "SELF_PROFILE_UPDATE",
      targetType: "USER",
      targetId: session.userId,
      metadata: { displayName: body.displayName },
      result: "SUCCESS",
      sourceIp
    });

    return ok({ displayName: body.displayName });
  } catch (error) {
    return fromError(error);
  }
}
