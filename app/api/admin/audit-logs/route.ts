import { Prisma } from "@prisma/client";
import { requireApiRole } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { fromError, ok } from "@/server/http";
import { humanizeAction } from "@/server/services/overview";

export async function GET(request: Request): Promise<Response> {
  try {
    await requireApiRole("ADMIN");
    const url = new URL(request.url);

    const where: Prisma.AuditLogWhereInput = {};
    const q = url.searchParams.get("q")?.trim();
    if (q) {
      where.OR = [
        { action: { contains: q, mode: "insensitive" } },
        { actorEmail: { contains: q, mode: "insensitive" } },
        { targetId: { contains: q, mode: "insensitive" } },
        { sourceIp: { contains: q, mode: "insensitive" } }
      ];
    }
    const action = url.searchParams.get("action")?.trim();
    if (action) where.action = { contains: action, mode: "insensitive" };
    const actor = url.searchParams.get("actor")?.trim();
    if (actor) where.actorEmail = { contains: actor, mode: "insensitive" };
    const clientId = url.searchParams.get("clientId")?.trim();
    if (clientId) where.clientAccountId = clientId;
    const nodeId = url.searchParams.get("nodeId")?.trim();
    if (nodeId) {
      where.OR = [
        ...(where.OR ? [where.OR] : []),
        { metadata: { path: ["nodeId"], equals: nodeId } }
      ] as Prisma.AuditLogWhereInput["OR"];
    }
    const result = url.searchParams.get("result")?.trim();
    if (result === "SUCCESS" || result === "FAILURE") where.result = result;

    const take = Math.min(Number(url.searchParams.get("limit") ?? "100"), 500);
    const offset = Math.max(Number(url.searchParams.get("offset") ?? "0"), 0);

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take,
        skip: offset,
        select: {
          id: true,
          createdAt: true,
          actorEmail: true,
          actorRole: true,
          action: true,
          targetType: true,
          targetId: true,
          result: true,
          sourceIp: true,
          clientAccountId: true,
          metadata: true
        }
      }),
      prisma.auditLog.count({ where })
    ]);

    return ok({
      logs: logs.map((l) => ({ ...l, humanized: humanizeAction(l.action) })),
      total
    });
  } catch (error) {
    return fromError(error);
  }
}
