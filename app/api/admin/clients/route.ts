import { ensureRole, requireApiSession } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { createClientSchema } from "@/server/validation/admin";
import { fromError, ok } from "@/server/http";
import { logAuditEvent } from "@/server/audit";
import { getSourceIpFromRequest } from "@/server/request";

export async function GET(): Promise<Response> {
  try {
    const session = await requireApiSession();
    ensureRole(session, ["ADMIN"]);

    const clients = await prisma.clientAccount.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        _count: {
          select: {
            users: true,
            assignments: true
          }
        }
      }
    });

    return ok({ clients });
  } catch (error) {
    return fromError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await requireApiSession();
    ensureRole(session, ["ADMIN"]);
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
