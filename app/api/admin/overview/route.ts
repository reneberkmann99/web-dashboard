import { prisma } from "@/server/db";
import { ensureRole, requireApiSession } from "@/server/auth/guards";
import { buildOverview, listContainersForSession } from "@/server/services/containers";
import { fromError, ok } from "@/server/http";

export async function GET(): Promise<Response> {
  try {
    const session = await requireApiSession();
    ensureRole(session, ["ADMIN"]);

    const [totalClients, totalNodes, recentActions, containers] = await Promise.all([
      prisma.clientAccount.count(),
      prisma.node.count(),
      prisma.auditLog.findMany({
        orderBy: { createdAt: "desc" },
        take: 12,
        select: {
          id: true,
          action: true,
          actorEmail: true,
          result: true,
          createdAt: true
        }
      }),
      listContainersForSession(session)
    ]);

    const summary = buildOverview(containers);

    return ok({
      totalClients,
      totalNodes,
      totalContainers: summary.totalContainers,
      runningContainers: summary.runningContainers,
      stoppedContainers: summary.stoppedContainers,
      offlineNodes: summary.offlineNodes,
      recentActions
    });
  } catch (error) {
    return fromError(error);
  }
}
