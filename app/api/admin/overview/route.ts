import { requireApiRole } from "@/server/auth/guards";
import {
  collectOverviewSnapshot,
  computeUtilization,
  collectAttentionItems,
  collectWorkloads,
  humanizeAction
} from "@/server/services/overview";
import { prisma } from "@/server/db";
import { fromError, ok } from "@/server/http";

export async function GET(): Promise<Response> {
  try {
    await requireApiRole("ADMIN");

    const snapshot = await collectOverviewSnapshot();
    const utilization = computeUtilization(snapshot.containersByNode);

    const [attention, workloads, recentActivity] = await Promise.all([
      collectAttentionItems(snapshot, utilization),
      collectWorkloads(snapshot),
      prisma.auditLog.findMany({
        orderBy: { createdAt: "desc" },
        take: 12,
        select: {
          id: true,
          action: true,
          actorEmail: true,
          result: true,
          createdAt: true,
          targetType: true,
          targetId: true
        }
      })
    ]);

    return ok({
      utilization,
      nodes: snapshot.nodes.map((n) => ({
        id: n.id,
        name: n.name,
        hostname: n.hostname,
        status: n.status,
        isActive: n.isActive,
        lastHeartbeatAt: n.lastHeartbeatAt,
        agentVersion: n.agentVersion,
        dockerVersion: n.dockerVersion,
        containerCount: n.containerCount,
        runningCount: n.runningCount,
        offline: n.offline,
        staleHeartbeat: n.staleHeartbeat
      })),
      attention,
      workloads,
      recentActivity: recentActivity.map((a) => ({
        ...a,
        humanized: humanizeAction(a.action)
      }))
    });
  } catch (error) {
    return fromError(error);
  }
}
