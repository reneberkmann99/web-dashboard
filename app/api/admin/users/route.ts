import { ensureRole, requireApiSession } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { hashPassword } from "@/server/auth/password";
import { createUserSchema } from "@/server/validation/admin";
import { fromError, ok } from "@/server/http";
import { logAuditEvent } from "@/server/audit";
import { getSourceIpFromRequest } from "@/server/request";

export async function GET(): Promise<Response> {
  try {
    const session = await requireApiSession();
    ensureRole(session, ["ADMIN"]);

    const [users, clients] = await Promise.all([
      prisma.user.findMany({
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          email: true,
          displayName: true,
          role: true,
          isActive: true,
          clientAccountId: true,
          clientAccount: {
            select: {
              id: true,
              name: true
            }
          }
        }
      }),
      prisma.clientAccount.findMany({
        where: { isActive: true },
        orderBy: { name: "asc" },
        select: { id: true, name: true }
      })
    ]);

    return ok({ users, clients });
  } catch (error) {
    return fromError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await requireApiSession();
    ensureRole(session, ["ADMIN"]);
    const sourceIp = getSourceIpFromRequest(request);

    const body = createUserSchema.parse(await request.json());
    const created = await prisma.user.create({
      data: {
        email: body.email.toLowerCase(),
        displayName: body.displayName,
        passwordHash: await hashPassword(body.password),
        role: body.role,
        isActive: body.isActive ?? true,
        clientAccountId: body.role === "CLIENT" ? body.clientAccountId ?? null : null
      }
    });

    await logAuditEvent({
      actorUserId: session.userId,
      actorEmail: session.email,
      actorRole: session.role,
      action: "USER_CREATE",
      targetType: "USER",
      targetId: created.id,
      metadata: {
        createdRole: created.role,
        createdEmail: created.email
      },
      result: "SUCCESS",
      sourceIp
    });

    return ok({ id: created.id }, 201);
  } catch (error) {
    return fromError(error);
  }
}
