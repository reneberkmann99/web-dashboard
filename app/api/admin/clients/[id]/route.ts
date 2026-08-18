import { requireApiRole } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { updateClientSchema, cuidParamSchema } from "@/server/validation/admin";
import { fromError, fail, ok } from "@/server/http";
import { logAuditEvent } from "@/server/audit";
import { getSourceIpFromRequest } from "@/server/request";
import { humanizeAction } from "@/server/services/overview";

export async function GET(
  _: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const id = cuidParamSchema.parse((await params).id);
    await requireApiRole("ADMIN");

    const client = await prisma.clientAccount.findUnique({
      where: { id },
      include: {
        users: {
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            email: true,
            displayName: true,
            role: true,
            isActive: true,
            lastLoginAt: true,
            authSource: true
          }
        },
        projects: {
          where: { isActive: true },
          orderBy: { name: "asc" },
          select: {
            id: true,
            name: true,
            slug: true,
            description: true,
            node: { select: { name: true } },
            _count: { select: { containers: true } }
          }
        },
        grants: {
          where: { isActive: true },
          orderBy: { createdAt: "desc" },
          include: {
            node: { select: { name: true } },
            project: { select: { id: true, name: true } },
            container: { select: { id: true, dockerName: true, dockerContainerId: true } }
          }
        },
        _count: { select: { users: true, projects: true, grants: true } }
      }
    });
    if (!client) {
      return fail("NOT_FOUND", "Client not found", 404);
    }

    const activity = await prisma.auditLog.findMany({
      where: { clientAccountId: id },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: {
        id: true,
        action: true,
        actorEmail: true,
        result: true,
        createdAt: true,
        metadata: true
      }
    });

    return ok({
      client: {
        id: client.id,
        name: client.name,
        slug: client.slug,
        isActive: client.isActive,
        createdAt: client.createdAt,
        users: client.users,
        projects: client.projects,
        grants: client.grants,
        counts: client._count
      },
      activity: activity.map((a) => ({ ...a, humanized: humanizeAction(a.action) }))
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

    const body = updateClientSchema.parse(await request.json());

    await prisma.clientAccount.update({
      where: { id },
      data: body
    });

    await logAuditEvent({
      actorUserId: session.userId,
      actorEmail: session.email,
      actorRole: session.role,
      clientAccountId: id,
      action: "CLIENT_UPDATE",
      targetType: "CLIENT_ACCOUNT",
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

    await prisma.clientAccount.update({
      where: { id },
      data: { isActive: false }
    });

    await logAuditEvent({
      actorUserId: session.userId,
      actorEmail: session.email,
      actorRole: session.role,
      clientAccountId: id,
      action: "CLIENT_DEACTIVATE",
      targetType: "CLIENT_ACCOUNT",
      targetId: id,
      result: "SUCCESS",
      sourceIp
    });

    return ok({ success: true });
  } catch (error) {
    return fromError(error);
  }
}
