import { requireApiRole } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { fromError, fail, ok } from "@/server/http";
import { updateUserSchema, cuidParamSchema } from "@/server/validation/admin";
import { getSourceIpFromRequest } from "@/server/request";
import { deleteUser, updatePlatformUser } from "@/server/services/user-lifecycle";

/** Platform-admin identity detail. Membership/access is deliberately shown
 * here, but changed only from this detail surface — never inline in All Users. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    await requireApiRole("ADMIN");
    const id = cuidParamSchema.parse((await params).id);
    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true, email: true, displayName: true, role: true, isActive: true,
        authSource: true, pamUsername: true, lastLoginAt: true, createdAt: true,
        clientAccountId: true, clientAccount: { select: { id: true, name: true } },
        activationToken: { select: { expiresAt: true, usedAt: true } },
        sessions: { select: { id: true, createdAt: true, lastUsedAt: true, expiresAt: true }, orderBy: { lastUsedAt: "desc" } }
      }
    });
    if (!user) return fail("NOT_FOUND", "User not found", 404);
    const activity = await prisma.auditLog.findMany({
      where: { OR: [{ actorUserId: id }, { targetType: "USER", targetId: id }] },
      select: { id: true, action: true, actorEmail: true, targetType: true, targetId: true, result: true, createdAt: true, metadata: true },
      orderBy: { createdAt: "desc" },
      take: 50
    });
    return ok({
      user: {
        ...user,
        pending: !user.isActive && user.activationToken?.usedAt == null,
        sessions: user.sessions.map((session) => ({ ...session, isCurrent: false }))
      },
      activity
    });
  } catch (error) {
    return fromError(error);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const session = await requireApiRole("ADMIN");
    const sourceIp = getSourceIpFromRequest(request);
    const id = cuidParamSchema.parse((await params).id);

    const body = updateUserSchema.parse(await request.json());
    const updated = await updatePlatformUser(session, id, body, sourceIp);
    return ok({ success: true, user: updated });
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
