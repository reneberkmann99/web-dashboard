import { prisma } from "@/server/db";
import { getCurrentSession } from "@/server/auth/session";
import { verifyPassword, hashPassword } from "@/server/auth/password";
import { fail, ok, fromError } from "@/server/http";
import { changePasswordSchema } from "@/server/validation/admin";
import { logAuditEvent } from "@/server/audit";
import { getSourceIpFromRequest } from "@/server/request";

/**
 * POST /api/auth/me/password — self-service password change for LOCAL accounts.
 * Re-verifies the current password before issuing a new one. PAM accounts are
 * rejected (their password is managed by the host system, not Noderaft).
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const session = await getCurrentSession();
    if (!session) {
      return fail("UNAUTHORIZED", "Authentication required", 401);
    }
    const sourceIp = getSourceIpFromRequest(request);
    const body = changePasswordSchema.parse(await request.json());

    const user = await prisma.user.findUnique({ where: { id: session.userId } });
    if (!user) {
      return fail("UNAUTHORIZED", "Authentication required", 401);
    }

    if (user.authSource !== "LOCAL" || !user.passwordHash) {
      return fail("NOT_ALLOWED", "Password is managed externally for this account", 403);
    }

    const valid = await verifyPassword(body.currentPassword, user.passwordHash);
    if (!valid) {
      await logAuditEvent({
        actorUserId: session.userId,
        actorEmail: session.email,
        actorRole: session.role,
        action: "SELF_PASSWORD_CHANGE_FAILED",
        targetType: "USER",
        targetId: session.userId,
        metadata: { reason: "incorrect_current_password" },
        result: "FAILURE",
        sourceIp
      });
      return fail("INVALID_CREDENTIALS", "Current password is incorrect", 400);
    }

    await prisma.user.update({
      where: { id: session.userId },
      data: { passwordHash: await hashPassword(body.newPassword) }
    });

    await logAuditEvent({
      actorUserId: session.userId,
      actorEmail: session.email,
      actorRole: session.role,
      action: "SELF_PASSWORD_CHANGE",
      targetType: "USER",
      targetId: session.userId,
      result: "SUCCESS",
      sourceIp
    });

    return ok({ success: true });
  } catch (error) {
    return fromError(error);
  }
}
