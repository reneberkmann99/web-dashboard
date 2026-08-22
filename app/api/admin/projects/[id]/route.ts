import { requireApiRole } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { updateProjectSchema, cuidParamSchema } from "@/server/validation/admin";
import { fail, fromError, ok } from "@/server/http";
import { logAuditEvent } from "@/server/audit";
import { getSourceIpFromRequest } from "@/server/request";
import { assertWorkloadReassignable, reconcileIngressEndpointsForDeactivatedWorkload } from "@/server/services/ingress";
import { lockProjectForUpdate } from "@/server/db";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const session = await requireApiRole("ADMIN");
    const sourceIp = getSourceIpFromRequest(request);
    const id = cuidParamSchema.parse((await params).id);

    const body = updateProjectSchema.parse(await request.json());

    // Same reassignment guard as app/api/admin/workloads/[id]/route.ts — this
    // route accepts the identical clientAccountId field and must not be a
    // way around it (see server/services/ingress.ts's
    // assertWorkloadReassignable doc comment for why reassigning a workload
    // with a bound ingress endpoint is unsafe). The check-then-update runs
    // under the Project row lock (see server/db.ts's lockProjectForUpdate
    // doc comment) so a concurrent createIngressEndpoint can't insert a
    // fresh endpoint between the check and the reassignment.
    if (body.clientAccountId !== undefined) {
      const existing = await prisma.project.findUnique({ where: { id }, select: { clientAccountId: true } });
      if (!existing) return fail("NOT_FOUND", "Workload not found", 404);
      const isReassignment = body.clientAccountId !== existing.clientAccountId;
      await prisma.$transaction(async (tx) => {
        if (isReassignment) {
          await lockProjectForUpdate(tx, id);
          await assertWorkloadReassignable(id, tx);
        }
        await tx.project.update({ where: { id }, data: body });
      });
    } else {
      await prisma.project.update({ where: { id }, data: body });
    }

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

    // Same reconciliation as any other workload deactivation path — see
    // reconcileIngressEndpointsForDeactivatedWorkload's doc comment.
    await reconcileIngressEndpointsForDeactivatedWorkload(id);

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
