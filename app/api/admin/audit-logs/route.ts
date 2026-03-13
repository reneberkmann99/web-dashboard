import { Prisma } from "@prisma/client";
import { requireApiRole } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { fromError, ok } from "@/server/http";

export async function GET(request: Request): Promise<Response> {
  try {
    await requireApiRole("ADMIN");

    const query = new URL(request.url).searchParams.get("q")?.trim();
    const where: Prisma.AuditLogWhereInput = query
      ? {
          OR: [
            {
              action: {
                contains: query,
                mode: "insensitive"
              }
            },
            {
              actorEmail: {
                contains: query,
                mode: "insensitive"
              }
            },
            {
              targetId: {
                contains: query,
                mode: "insensitive"
              }
            }
          ]
        }
      : {};

    const logs = await prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true,
        createdAt: true,
        actorEmail: true,
        actorRole: true,
        action: true,
        targetType: true,
        targetId: true,
        result: true,
        sourceIp: true
      }
    });

    return ok({ logs });
  } catch (error) {
    return fromError(error);
  }
}
