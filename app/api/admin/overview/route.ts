import { requireApiRole } from "@/server/auth/guards";
import {
  collectOverviewSnapshot,
  computeUtilization,
  collectAttentionItems,
  collectWorkloads,
  humanizeAction
} from "@/server/services/overview";
import { getFleetSummary, getRecentFailures, getActiveOperations, getSustainedNodePressure } from "@/server/services/attention";
import { resourceThresholds, nodeResourceWindowLabel } from "@/server/services/attention-config";
import { resolveActivityTargetLabels } from "@/server/services/activity";
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

    // CPU/RAM shown to operators is the sustained-window average (same
    // NodeResourceSample data attention pressure derivation reads), not the
    // instantaneous per-request sample — that instantaneous value swings
    // enough between two independent polls (Overview vs Nodes list) to look
    // like disagreeing telemetry when it was really the same metric sampled
    // at two different instants (design review round 2, §4).
    const pressureByNode = await getSustainedNodePressure(snapshot.nodes.filter((n) => n.isActive).map((n) => n.id));

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
          targetId: true,
          metadata: true
        }
      }),
      getFleetSummary(snapshot, workloadHealthCounts),
      getRecentFailures(),
      getActiveOperations()
    ]);

    // Resolve target names for dense activity rows (WHAT + resource + actor +
    // time) — the same resolver the full Activity page uses, so a resource's
    // name never disagrees between Overview and Activity (round 2 §16).
    const activityLabels = await resolveActivityTargetLabels(recentActivity);

    return ok({
      utilization,
      fleetSummary,
      resourceThresholds: resourceThresholds(),
      resourceWindowLabel: nodeResourceWindowLabel(),
      nodes: snapshot.nodes.map((n) => {
        const pressure = pressureByNode.get(n.id);
        const sys = (n.systemInfo ?? {}) as Record<string, unknown>;
        return {
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
          staleHeartbeat: n.staleHeartbeat,
          telemetryCurrent: n.polledOnline,
          systemInfo: n.systemInfo
            ? { ...sys, cpuPercent: pressure?.cpu ?? sys.cpuPercent ?? null, memPercent: pressure?.mem ?? sys.memPercent ?? null }
            : null
        };
      }),
      attention,
      workloads,
      recentActivity: recentActivity.map((a) => {
        const resolved = a.targetId ? activityLabels.get(`${a.targetType}:${a.targetId}`) : undefined;
        return {
          ...a,
          humanized: humanizeAction(a.action),
          targetLabel: resolved?.label ?? null,
          targetDeleted: resolved?.deleted ?? false
        };
      }),
      recentFailures,
      activeOperations
    });
  } catch (error) {
    return fromError(error);
  }
}
