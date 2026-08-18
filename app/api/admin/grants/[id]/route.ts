import { requireApiRole } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { updateGrantSchema, cuidParamSchema } from "@/server/validation/admin";
import { fromError, ok } from "@/server/http";
import { logAuditEvent } from "@/server/audit";
import { getSourceIpFromRequest } from "@/server/request";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const session = await requireApiRole("ADMIN");
    const sourceIp = getSourceIpFromRequest(request);
    const id = cuidParamSchema.parse((await params).id);

    const body = updateGrantSchema.parse(await request.json());

    await prisma.accessGrant.update({ where: { id }, data: body });

    await logAuditEvent({
      actorUserId: session.userId,
      actorEmail: session.email,
      actorRole: session.role,
      action: "GRANT_UPDATE",
      targetType: "ACCESS_GRANT",
      targetId: id,
      metadata: body,
      result: "SUCCESS",
      sourceIp
    });

    return ok({ success: true });
  } catch (error) {
    return fromError(error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const session = await requireApiRole("ADMIN");
    const sourceIp = getSourceIpFromRequest(request);
    const id = cuidParamSchema.parse((await params).id);

    await prisma.accessGrant.update({ where: { id }, data: { isActive: false } });

    await logAuditEvent({
      actorUserId: session.userId,
      actorEmail: session.email,
      actorRole: session.role,
      action: "GRANT_DEACTIVATE",
      targetType: "ACCESS_GRANT",
      targetId: id,
      result: "SUCCESS",
      sourceIp
    });

    return ok({ success: true });
  } catch (error) {
    return fromError(error);
  }
}
