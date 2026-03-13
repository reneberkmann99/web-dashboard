import { ensureRole, requireApiSession } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { hashPassword } from "@/server/auth/password";
import { fromError, ok } from "@/server/http";
import { updateUserSchema } from "@/server/validation/admin";
import { logAuditEvent } from "@/server/audit";
import { getSourceIpFromRequest } from "@/server/request";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const session = await requireApiSession();
    ensureRole(session, ["ADMIN"]);
    const sourceIp = getSourceIpFromRequest(request);
    const { id } = await params;

    const body = updateUserSchema.parse(await request.json());

    await prisma.user.update({
      where: { id },
      data: {
        displayName: body.displayName,
        role: body.role,
        isActive: body.isActive,
        clientAccountId:
          body.role === "ADMIN"
            ? null
            : body.clientAccountId !== undefined
              ? body.clientAccountId
              : undefined,
        ...(body.password ? { passwordHash: await hashPassword(body.password) } : {})
      }
    });

    await logAuditEvent({
      actorUserId: session.userId,
      actorEmail: session.email,
      actorRole: session.role,
      action: "USER_UPDATE",
      targetType: "USER",
      targetId: id,
      metadata: {
        ...body,
        ...(body.password ? { password: "<redacted>" } : {})
      },
      result: "SUCCESS",
      sourceIp
    });

    return ok({ success: true });
  } catch (error) {
    return fromError(error);
  }
}
