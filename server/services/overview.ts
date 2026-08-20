import { prisma } from "@/server/db";
import { nodeAgentClient } from "@/server/services/node-agent/client";
import { reconcileComposeIfDue } from "@/server/services/compose";
import { recordNodePoll, type HeartbeatState } from "@/server/services/node-heartbeat";
import { syncAttentionIfDue, getAttentionFeedForAdmin, getAttentionMap } from "@/server/services/attention";
import type { RuntimeContainer } from "@/server/services/node-agent/types";
import type { WorkloadSummary } from "@/types/domain";
import { humanizeAction } from "@/lib/format";

export { humanizeAction };
export type { HeartbeatState };

/**
 * Overview + Workloads data assembly for the operations dashboards.
 *
 * All data derives from one bounded snapshot pass per node, then utilization,
 * attention items, and workload summaries are computed from that snapshot.
 * Node polls run concurrently so one unreachable host cannot serialize the
 * timeout across an otherwise healthy 20-node fleet.
 */

export type NodeOperationalView = {
  id: string;
  name: string;
  hostname: string;
  status: string;
  isActive: boolean;
  lastHeartbeatAt: Date | null;
  heartbeatState: HeartbeatState;
  agentVersion: string | null;
  dockerVersion: string | null;
  systemInfo: Record<string, unknown> | null;
  containerCount: number;
  runningCount: number;
  /** True when this specific poll reached the agent (used for compose reconcile gating, not status). */
  polledOnline: boolean;
  offline: boolean;
  staleHeartbeat: boolean;
};

export type OverviewSnapshot = {
  nodes: NodeOperationalView[];
  containersByNode: Map<string, RuntimeContainer[]>;
};

export async function collectOverviewSnapshot(): Promise<OverviewSnapshot> {
  const [nodes, activeContainerCounts] = await Promise.all([
    prisma.node.findMany({ orderBy: { name: "asc" } }),
    // One fleet-wide aggregate is both clearer and more reliable than
    // deriving offline impact from the empty result of a failed live poll.
    // It remains O(nodes), never one query per node/container.
    prisma.container.groupBy({
      by: ["nodeId"],
      where: { isActive: true },
      _count: { _all: true }
    })
  ]);
  const activeCountByNode = new Map(activeContainerCounts.map((row) => [row.nodeId, row._count._all]));
  const containersByNode = new Map<string, RuntimeContainer[]>();

  const views = await Promise.all(nodes.map(async (node): Promise<NodeOperationalView> => {
    let containers: RuntimeContainer[] = [];
    let polledOnline = false;
    try {
      const payload = await nodeAgentClient.listContainers(node);
      containers = payload.containers;
      polledOnline = payload.nodeOnline;
    } catch {
      polledOnline = false;
    }
    containersByNode.set(node.id, containers);

    const poll = await recordNodePoll(node, polledOnline);

    // Compose discovery + reconciliation, throttled per node. Only when this
    // poll actually reached the agent (an offline/timed-out agent never
    // triggers a reconcile).
    if (polledOnline) {
      await reconcileComposeIfDue(node.id, containers);
    }

    const running = containers.filter((c) => c.status === "running").length;

    return {
      id: node.id,
      name: node.name,
      hostname: node.hostname,
      status: poll.status,
      isActive: node.isActive,
      lastHeartbeatAt: poll.lastHeartbeatAt,
      heartbeatState: poll.heartbeatState,
      agentVersion: poll.agentVersion,
      dockerVersion: poll.dockerVersion,
      systemInfo: poll.systemInfo,
      // Preserve impact context while offline: a failed live poll returns no
      // containers, but the last discovered inventory still tells the
      // operator how many resources are affected.
      containerCount: polledOnline ? containers.length : (activeCountByNode.get(node.id) ?? 0),
      runningCount: running,
      polledOnline,
      offline: poll.heartbeatState === "OFFLINE",
      staleHeartbeat: poll.heartbeatState === "STALE"
    };
  }));

  return { nodes: views, containersByNode };
}

export type UtilizationTotals = {
  cpuPercent: number | null;
  memoryUsage: string | null;
  memoryBytes: number;
  totalContainers: number;
  runningContainers: number;
  stoppedContainers: number;
  unhealthyContainers: number;
  restartingContainers: number;
};

export function computeUtilization(containersByNode: Map<string, RuntimeContainer[]>): UtilizationTotals {
  const totals: UtilizationTotals = {
    cpuPercent: 0,
    memoryUsage: null,
    memoryBytes: 0,
    totalContainers: 0,
    runningContainers: 0,
    stoppedContainers: 0,
    unhealthyContainers: 0,
    restartingContainers: 0
  };
  let cpuSum = 0;
  let measured = 0;
  let memBytes = 0;

  for (const containers of containersByNode.values()) {
    totals.totalContainers += containers.length;
    for (const c of containers) {
      if (c.status === "running") totals.runningContainers += 1;
      if (c.status === "stopped") totals.stoppedContainers += 1;
      if (c.health === "unhealthy" || c.status === "unhealthy") totals.unhealthyContainers += 1;
      if (c.status === "restarting") totals.restartingContainers += 1;
      if (typeof c.cpuPercent === "number") {
        cpuSum += c.cpuPercent;
        measured += 1;
      }
      if (typeof c.memoryUsage === "string") {
        const raw = c.memoryUsage.split("/")[0]?.trim();
        const mb = raw?.endsWith("MiB") ? Number(raw.slice(0, -3)) : raw?.endsWith("GiB") ? Number(raw.slice(0, -3)) * 1024 : Number(raw);
        if (!Number.isNaN(mb)) memBytes += mb * 1024 * 1024;
      }
    }
  }

  totals.cpuPercent = measured > 0 ? Number((cpuSum / measured).toFixed(1)) : null;
  totals.memoryBytes = memBytes;
  totals.memoryUsage = memBytes > 0 ? `${(memBytes / 1024 / 1024 / 1024).toFixed(2)} GiB` : null;
  return totals;
}

/**
 * Attention feed for the Overview "Needs attention" section (§3). This runs
 * the throttled attention-sync pass (persists AttentionState transitions,
 * logs Activity for new/resolved conditions) and returns the deduplicated
 * admin-scoped feed. All derivation logic itself lives in
 * server/services/attention.ts — this is deliberately a thin wrapper so the
 * Overview route doesn't need to know about the sync/read split.
 */
export async function collectAttentionItems(snapshot: OverviewSnapshot): Promise<import("@/types/domain").AttentionItem[]> {
  await syncAttentionIfDue(snapshot);
  return getAttentionFeedForAdmin();
}

export async function collectWorkloads(snapshot: OverviewSnapshot): Promise<WorkloadSummary[]> {
  await syncAttentionIfDue(snapshot);
  const projects = await prisma.project.findMany({
    where: { isActive: true },
    include: {
      node: { select: { id: true, name: true } },
      clientAccount: { select: { id: true, name: true } },
      containers: { where: { isActive: true }, select: { dockerContainerId: true, dockerName: true } },
      deployment: { select: { runtimeState: true } },
      _count: { select: { containers: true, grants: true } }
    }
  });

  const [attentionMap, projectEvents] = await Promise.all([
    getAttentionMap(),
    prisma.auditLog.findMany({
      where: { targetType: "PROJECT", targetId: { in: projects.map((p) => p.id) } },
      orderBy: { createdAt: "desc" },
      select: { targetId: true, action: true, createdAt: true, result: true }
    })
  ]);
  const lastEventByProject = new Map<string, (typeof projectEvents)[number]>();
  for (const event of projectEvents) {
    if (event.targetId && !lastEventByProject.has(event.targetId)) {
      lastEventByProject.set(event.targetId, event);
    }
  }

  const summaries: WorkloadSummary[] = [];
  for (const project of projects) {
    const node = snapshot.nodes.find((n) => n.id === project.nodeId);
    const live = snapshot.containersByNode.get(project.nodeId) ?? [];
    const projectIds = new Set(project.containers.map((c) => c.dockerContainerId));
    const inProject = live.filter((c) => projectIds.has(c.id));

    let running = 0;
    let stopped = 0;
    let unhealthy = 0;
    let cpuSum = 0;
    let cpuCount = 0;
    let memSum = 0;
    for (const c of inProject) {
      if (c.status === "running") running += 1;
      if (c.status === "stopped") stopped += 1;
      if (c.health === "unhealthy" || c.status === "unhealthy") unhealthy += 1;
      if (typeof c.cpuPercent === "number") {
        cpuSum += c.cpuPercent;
        cpuCount += 1;
      }
      if (typeof c.memoryUsage === "string") {
        const raw = c.memoryUsage.split("/")[0]?.trim();
        const mb = raw?.endsWith("MiB") ? Number(raw.slice(0, -3)) : raw?.endsWith("GiB") ? Number(raw.slice(0, -3)) * 1024 : Number(raw);
        if (!Number.isNaN(mb)) memSum += mb;
      }
    }

    const total = project.containers.length;
    // Live service health is knowable only when this request reached the
    // agent. During heartbeat grace, connectivity may still be ONLINE/STALE,
    // but an empty failed poll must not be presented as a down workload.
    const telemetryCurrent = node?.polledOnline === true;
    const managed = Boolean(project.deployment);
    const runtimeState = project.deployment?.runtimeState ?? null;

    // Container-derived health first, then layered with managed-deployment
    // runtime state — a managed workload with all containers "running" but
    // DEGRADED/DRIFTED runtime must never be reported as healthy (§6/§19:
    // "Do not call DEGRADED healthy just because containers are technically
    // running.").
    let health: WorkloadSummary["health"] = !telemetryCurrent || total === 0
      ? "unknown"
      : unhealthy > 0
        ? "degraded"
        : running === total
          ? "healthy"
          : running === 0
            ? "down"
            : "degraded";
    if (managed && telemetryCurrent) {
      if (runtimeState === "DRIFTED") health = "down";
      else if (runtimeState === "DEGRADED" && health === "healthy") health = "degraded";
    }

    const lastEvent = lastEventByProject.get(project.id) ?? null;

    const attention = attentionMap.get(`WORKLOAD:${project.id}`) ?? (health === "healthy" ? "healthy" : health === "unknown" ? "unknown" : undefined);

    summaries.push({
      id: project.id,
      name: project.name,
      slug: project.slug,
      description: project.description,
      source: managed ? "MANAGED" : project.source,
      nodeId: project.nodeId,
      nodeName: project.node.name,
      clientId: project.clientAccount?.id ?? null,
      clientName: project.clientAccount?.name ?? null,
      totalContainers: total,
      runningContainers: running,
      stoppedContainers: stopped,
      unhealthyContainers: unhealthy,
      health,
      cpuPercent: cpuCount > 0 ? Number((cpuSum / cpuCount).toFixed(1)) : null,
      memoryUsage: memSum > 0 ? `${memSum.toFixed(0)} MiB` : null,
      lastEvent: lastEvent
        ? { action: lastEvent.action, createdAt: lastEvent.createdAt.toISOString(), result: lastEvent.result }
        : null,
      attention: attention ?? "warning",
      managed,
      deploymentRuntimeState: runtimeState
    });
  }

  return summaries.sort((a, b) => a.name.localeCompare(b.name));
}
