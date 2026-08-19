import { requireApiRole } from "@/server/auth/guards";
import { buildOverview, listContainersForSession } from "@/server/services/containers";
import { prisma } from "@/server/db";
import { collectOverviewSnapshot, collectWorkloads, humanizeAction } from "@/server/services/overview";
import { fromError, ok } from "@/server/http";

/**
 * Client dashboard: "are my services healthy? what changed recently?"
 * Scoped entirely to the caller's grants and client account.
 */
export async function GET(): Promise<Response> {
  try {
    const session = await requireApiRole("CLIENT");
    const clientId = session.clientAccountId ?? "__invalid__";

    const containers = await listContainersForSession(session);
    const overview = buildOverview(containers);

    // Workload health — only workloads this client can see.
    const grantedProjectIds = await prisma.accessGrant.findMany({
      where: { clientAccountId: clientId, isActive: true, projectId: { not: null } },
      select: { projectId: true }
    });
    const idSet = new Set(grantedProjectIds.map((g) => g.projectId).filter((v): v is string => !!v));

    const snapshot = await collectOverviewSnapshot();
    const allWorkloads = await collectWorkloads(snapshot);
    const workloads = allWorkloads.filter((w) => w.clientId === clientId || (w.id && idSet.has(w.id)));

    const recentActivity = await prisma.auditLog.findMany({
      where: { clientAccountId: clientId },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: { id: true, action: true, actorEmail: true, result: true, createdAt: true, targetType: true }
    });

    return ok({
      overview,
      workloads,
      recentActivity: recentActivity.map((a) => ({ ...a, humanized: humanizeAction(a.action) })),
      recentContainers: containers.slice(0, 8)
    });
  } catch (error) {
    return fromError(error);
  }
}
