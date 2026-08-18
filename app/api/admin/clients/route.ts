import { requireApiRole } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { createClientSchema } from "@/server/validation/admin";
import { fromError, ok } from "@/server/http";
import { logAuditEvent } from "@/server/audit";
import { getSourceIpFromRequest } from "@/server/request";

export async function GET(): Promise<Response> {
  try {
    await requireApiRole("ADMIN");

    const clients = await prisma.clientAccount.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        _count: { select: { users: true, assignments: true, grants: true, projects: true } }
      }
    });

    // last activity per client
    const withActivity = await Promise.all(
      clients.map(async (client) => {
        const last = await prisma.auditLog.findFirst({
          where: { clientAccountId: client.id },
          orderBy: { createdAt: "desc" },
          select: { action: true, createdAt: true, result: true }
        });
        const activeUsers = await prisma.user.count({
          where: { clientAccountId: client.id, isActive: true }
        });
        const projectIds = await prisma.project.findMany({
          where: { clientAccountId: client.id, isActive: true },
          select: { id: true }
        });
        const containerCount = await prisma.accessGrant.count({
          where: { clientAccountId: client.id, isActive: true }
        });
        return {
          ...client,
          activeUsers,
          workloadCount: projectIds.length,
          containerCount,
          lastActivity: last
            ? { action: last.action, createdAt: last.createdAt.toISOString(), result: last.result }
            : null
        };
      })
    );

    return ok({ clients: withActivity });
  } catch (error) {
    return fromError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await requireApiRole("ADMIN");
    const sourceIp = getSourceIpFromRequest(request);

    const body = createClientSchema.parse(await request.json());
    const created = await prisma.clientAccount.create({
      data: {
        name: body.name,
        slug: body.slug,
        isActive: body.isActive ?? true
      }
    });

    await logAuditEvent({
      actorUserId: session.userId,
      actorEmail: session.email,
      actorRole: session.role,
      clientAccountId: created.id,
      action: "CLIENT_CREATE",
      targetType: "CLIENT_ACCOUNT",
      targetId: created.id,
      result: "SUCCESS",
      sourceIp
    });

    return ok({ id: created.id }, 201);
  } catch (error) {
    return fromError(error);
  }
}
