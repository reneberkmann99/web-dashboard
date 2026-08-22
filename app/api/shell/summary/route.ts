import { requireApiSession } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { fromError, ok } from "@/server/http";
import { getDeduplicatedAdminAttentionRows } from "@/server/services/attention";

/**
 * Read-only shell summary. Unlike Overview, this endpoint never polls agents
 * or advances attention lifecycle state; it reports the last persisted agent
 * heartbeat so the top bar reflects real data freshness without side effects.
 */
export async function GET(): Promise<Response> {
  try {
    const session = await requireApiSession();
    const admin = session.role === "ADMIN";
    const nodeWhere = admin
      ? { isActive: true }
      : { isActive: true, projects: { some: { isActive: true, clientAccountId: session.clientAccountId ?? "__none__" } } };

    const nodes = await prisma.node.findMany({
      where: nodeWhere,
      select: { status: true, lastHeartbeatAt: true }
    });
    const freshAt = nodes.reduce<Date | null>((latest, node) => {
      if (!node.lastHeartbeatAt) return latest;
      return !latest || node.lastHeartbeatAt > latest ? node.lastHeartbeatAt : latest;
    }, null);

    if (!admin) {
      return ok({
        freshAt: freshAt?.toISOString() ?? null,
        fleetSummary: null,
        nodesTotal: nodes.length,
        nodesOnline: nodes.filter((node) => node.status === "ONLINE").length
      });
    }

    // attentionIssues must use the same deduplicated, severity-filtered rows
    // as Overview/Attention (getDeduplicatedAdminAttentionRows) — a raw
    // AttentionState count includes INFO-severity and node-offline-suppressed
    // rows the rest of the app never surfaces, which showed up as the shell
    // badge disagreeing with the Overview and Attention page counts.
    const [workloadsTotal, containersTotal, attentionRows] = await Promise.all([
      prisma.project.count({ where: { isActive: true } }),
      prisma.container.count({ where: { isActive: true } }),
      getDeduplicatedAdminAttentionRows()
    ]);
    const attentionIssues = attentionRows.length;

    return ok({
      freshAt: freshAt?.toISOString() ?? null,
      nodesTotal: nodes.length,
      nodesOnline: nodes.filter((node) => node.status === "ONLINE").length,
      fleetSummary: { workloadsTotal, containersTotal, nodesTotal: nodes.length, attentionIssues }
    });
  } catch (error) {
    return fromError(error);
  }
}
