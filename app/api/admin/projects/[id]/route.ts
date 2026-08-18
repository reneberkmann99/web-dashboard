import { requireApiRole } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { updateProjectSchema, cuidParamSchema } from "@/server/validation/admin";
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

    const body = updateProjectSchema.parse(await request.json());

    await prisma.project.update({ where: { id }, data: body });

    await logAuditEvent({
      actorUserId: session.userId,
      actorEmail: session.email,
      actorRole: session.role,
      action: "PROJECT_UPDATE",
      targetType: "PROJECT",
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

    // Soft-delete: keep history, drop visibility. Containers keep their
    // projectId via ON DELETE SET NULL? No — we soft-delete, so set isActive=false.
    await prisma.project.update({
      where: { id },
      data: { isActive: false }
    });

    await logAuditEvent({
      actorUserId: session.userId,
      actorEmail: session.email,
      actorRole: session.role,
      action: "PROJECT_DEACTIVATE",
      targetType: "PROJECT",
      targetId: id,
      result: "SUCCESS",
      sourceIp
    });

    return ok({ success: true });
  } catch (error) {
    return fromError(error);
  }
}
