import { requireApiRole } from "@/server/auth/guards";
import {
  collectOverviewSnapshot,
  computeUtilization,
  collectAttentionItems,
  collectWorkloads,
  humanizeAction
} from "@/server/services/overview";
import { getFleetSummary, getRecentFailures, getActiveOperations } from "@/server/services/attention";
import { prisma } from "@/server/db";
import { fromError, ok } from "@/server/http";

export async function GET(): Promise<Response> {
  try {
    await requireApiRole("ADMIN");

    const snapshot = await collectOverviewSnapshot();
    const utilization = computeUtilization(snapshot.containersByNode);

    // Attention must be collected before workloads/fleet summary — it runs
    // the (throttled) sync pass that persists AttentionState transitions
    // and records the resource samples workloads/fleet summary then read.
    const attention = await collectAttentionItems(snapshot);
    const workloads = await collectWorkloads(snapshot);
    const workloadHealthCounts = {
      healthy: workloads.filter((w) => w.health === "healthy").length,
      total: workloads.length,
      degraded: workloads.filter((w) => w.health === "degraded" || w.health === "down").length
    };

    const [recentActivity, fleetSummary, recentFailures, activeOperations] = await Promise.all([
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
      }),
      getFleetSummary(snapshot, workloadHealthCounts),
      getRecentFailures(),
      getActiveOperations()
    ]);

    return ok({
      utilization,
      fleetSummary,
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
      })),
      recentFailures,
      activeOperations
    });
  } catch (error) {
    return fromError(error);
  }
}
