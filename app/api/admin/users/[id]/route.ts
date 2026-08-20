import { requireApiRole } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { fromError, fail, ok } from "@/server/http";
import { updateUserSchema, cuidParamSchema } from "@/server/validation/admin";
import { logAuditEvent } from "@/server/audit";
import { getSourceIpFromRequest } from "@/server/request";
import { deleteUser } from "@/server/services/user-lifecycle";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const session = await requireApiRole("ADMIN");
    const sourceIp = getSourceIpFromRequest(request);
    const id = cuidParamSchema.parse((await params).id);

    const body = updateUserSchema.parse(await request.json());
    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) {
      return fail("NOT_FOUND", "User not found", 404);
    }

    // Role-change invariant: a client role requires a client account.
    // Setting role to ADMIN always clears the client link; setting a client
    // role without providing a clientAccountId keeps the existing link when
    // present, and is rejected when there is none (prevents the historical
    // "CLIENT role with no client" data corruption bug).
    let nextClientAccountId: string | null | undefined = body.clientAccountId;
    if (body.role !== undefined) {
      if (body.role === "ADMIN") {
        nextClientAccountId = null;
      } else if (body.clientAccountId === undefined) {
        if (!target.clientAccountId) {
          return fail("VALIDATION_ERROR", "A client role requires a client account", 400);
        }
        nextClientAccountId = target.clientAccountId; // keep existing
      }
    }

    await prisma.user.update({
      where: { id },
      data: {
        displayName: body.displayName,
        role: body.role,
        isActive: body.isActive,
        clientAccountId: nextClientAccountId
      }
    });

    await logAuditEvent({
      actorUserId: session.userId,
      actorEmail: session.email,
      actorRole: session.role,
      action: "USER_UPDATE",
      targetType: "USER",
      targetId: id,
      metadata: { ...body, password: undefined },
      result: "SUCCESS",
      sourceIp
    });

    return ok({ success: true });
  } catch (error) {
    return fromError(error);
  }
}

/**
 * DELETE /api/admin/users/:id — hard-delete a user (removes PPI, preserves
 * audit history via actor snapshots). Refuses to remove the last active admin.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const session = await requireApiRole("ADMIN");
    const sourceIp = getSourceIpFromRequest(request);
    const id = cuidParamSchema.parse((await params).id);

    const snapshot = await deleteUser(session, id, sourceIp);
    return ok({ id: snapshot.id, deleted: true });
  } catch (error) {
    return fromError(error);
  }
}
