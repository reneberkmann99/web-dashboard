import { Prisma } from "@prisma/client";
import { requireApiRole } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { fromError, ok } from "@/server/http";
import { humanizeAction } from "@/server/services/overview";

/**
 * Admin activity feed with server-side filtering + pagination.
 * Filters: q (free text), result, actor, action, clientId, nodeId,
 * containerId, projectId, and a createdAt range (from/to).
 */
export async function GET(request: Request): Promise<Response> {
  try {
    await requireApiRole("ADMIN");
    const url = new URL(request.url);

    const where: Prisma.AuditLogWhereInput = {};
    const ors: Prisma.AuditLogWhereInput[] = [];

    const q = url.searchParams.get("q")?.trim();
    if (q) {
      ors.push(
        { action: { contains: q, mode: "insensitive" } },
        { actorEmail: { contains: q, mode: "insensitive" } },
        { targetId: { contains: q, mode: "insensitive" } },
        { sourceIp: { contains: q, mode: "insensitive" } }
      );
    }

    const actor = url.searchParams.get("actor")?.trim();
    if (actor) {
      ors.push({ actorEmail: { contains: actor, mode: "insensitive" } });
    }

    const action = url.searchParams.get("action")?.trim();
    if (action) {
      ors.push({ action: { contains: action, mode: "insensitive" } });
    }

    if (ors.length > 0) {
      where.OR = ors;
    }

    const result = url.searchParams.get("result")?.trim();
    if (result === "SUCCESS" || result === "FAILURE") where.result = result;

    const clientId = url.searchParams.get("clientId")?.trim();
    if (clientId) where.clientAccountId = clientId;

    const nodeId = url.searchParams.get("nodeId")?.trim();
    if (nodeId) {
      where.OR = [
        ...(where.OR ? [where.OR] : []),
        { metadata: { path: ["nodeId"], equals: nodeId } }
      ] as Prisma.AuditLogWhereInput["OR"];
    }

    const containerId = url.searchParams.get("containerId")?.trim();
    if (containerId) {
      where.OR = [
        ...(where.OR ? [where.OR] : []),
        { metadata: { path: ["dockerContainerId"], equals: containerId } }
      ] as Prisma.AuditLogWhereInput["OR"];
    }

    const projectId = url.searchParams.get("projectId")?.trim();
    if (projectId) {
      where.OR = [
        ...(where.OR ? [where.OR] : []),
        { targetType: "PROJECT", targetId: projectId },
        { metadata: { path: ["projectId"], equals: projectId } }
      ] as Prisma.AuditLogWhereInput["OR"];
    }

    const from = url.searchParams.get("from")?.trim();
    const to = url.searchParams.get("to")?.trim();
    if (from || to) {
      where.createdAt = {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to ? { lte: new Date(to) } : {})
      };
    }

    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "25"), 1), 100);
    const page = Math.max(Number(url.searchParams.get("page") ?? "1"), 1);
    const skip = (page - 1) * limit;

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip,
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
      total,
      page,
      limit,
      pageCount: Math.max(1, Math.ceil(total / limit))
    });
  } catch (error) {
    return fromError(error);
  }
}
