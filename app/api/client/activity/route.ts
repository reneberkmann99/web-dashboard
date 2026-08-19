import { requireApiRole } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { fromError, ok } from "@/server/http";
import { humanizeAction } from "@/server/services/overview";

/**
 * Client-scoped activity: audit events for the caller's own client account.
 * CLIENT_ADMIN sees their team's actions; OPERATOR/VIEWER also see client
 * activity (it is their own tenant's history, not platform administration).
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const session = await requireApiRole("CLIENT");
    if (!session.clientAccountId) {
      return ok({ events: [], total: 0 });
    }

    const url = new URL(request.url);
    const take = Math.min(Number(url.searchParams.get("limit") ?? "50"), 200);

    const [events, total] = await Promise.all([
      prisma.auditLog.findMany({
        where: { clientAccountId: session.clientAccountId },
        orderBy: { createdAt: "desc" },
        take,
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
          metadata: true
        }
      }),
      prisma.auditLog.count({ where: { clientAccountId: session.clientAccountId } })
    ]);

    return ok({
      events: events.map((e) => ({ ...e, humanized: humanizeAction(e.action) })),
      total
    });
  } catch (error) {
    return fromError(error);
  }
}
