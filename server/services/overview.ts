import { prisma } from "@/server/db";
import { nodeAgentClient } from "@/server/services/node-agent/client";
import { reconcileComposeIfDue } from "@/server/services/compose";
import type { RuntimeContainer } from "@/server/services/node-agent/types";
import type { AttentionItem, WorkloadSummary } from "@/types/domain";
import { humanizeAction } from "@/lib/format";

export { humanizeAction };

/**
 * Overview + Workloads data assembly for the operations dashboards.
 *
 * All data derives from a single snapshot pass: each node's agent is queried
 * exactly once, then utilization, attention items, and workload summaries are
 * computed from that snapshot. This avoids hammering the Docker CLI on rapid
 * dashboard refreshes.
 */

const STALE_HEARTBEAT_MS = 5 * 60 * 1000;

export type NodeOperationalView = {
  id: string;
  name: string;
  hostname: string;
  status: string;
  isActive: boolean;
  lastHeartbeatAt: Date | null;
  agentVersion: string | null;
  dockerVersion: string | null;
  containerCount: number;
  runningCount: number;
  offline: boolean;
  staleHeartbeat: boolean;
};

export type OverviewSnapshot = {
  nodes: NodeOperationalView[];
  containersByNode: Map<string, RuntimeContainer[]>;
};

export async function collectOverviewSnapshot(): Promise<OverviewSnapshot> {
  const nodes = await prisma.node.findMany({ orderBy: { name: "asc" } });
  const views: NodeOperationalView[] = [];
  const containersByNode = new Map<string, RuntimeContainer[]>();

  for (const node of nodes) {
    let containers: RuntimeContainer[] = [];
    let online = false;
    try {
      const payload = await nodeAgentClient.listContainers(node);
      containers = payload.containers;
      online = payload.nodeOnline;
    } catch {
      online = false;
    }
    containersByNode.set(node.id, containers);

    let status: string = node.status;
    let lastHeartbeatAt: Date | null = node.lastHeartbeatAt;
    if (online) {
      await prisma.node
        .update({ where: { id: node.id }, data: { status: "ONLINE", lastHeartbeatAt: new Date() } })
        .catch(() => undefined);
      status = "ONLINE";
      lastHeartbeatAt = new Date();
    } else if (node.status !== "INACTIVE") {
      await prisma.node
        .update({ where: { id: node.id }, data: { status: "OFFLINE" } })
        .catch(() => undefined);
      status = "OFFLINE";
    }

    // Compose discovery + reconciliation, throttled per node.
    if (online) {
      await reconcileComposeIfDue(node.id, containers);
    }

    const running = containers.filter((c) => c.status === "running").length;
    const offline = status === "OFFLINE" || status === "UNKNOWN";
    const staleHeartbeat =
      !!lastHeartbeatAt && Date.now() - lastHeartbeatAt.getTime() > STALE_HEARTBEAT_MS;

    views.push({
      id: node.id,
      name: node.name,
      hostname: node.hostname,
      status,
      isActive: node.isActive,
      lastHeartbeatAt,
      agentVersion: node.agentVersion,
      dockerVersion: node.dockerVersion,
      containerCount: containers.length,
      runningCount: running,
      offline,
      staleHeartbeat
    });
  }

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
      if (c.status === "unhealthy") totals.unhealthyContainers += 1;
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

export async function collectAttentionItems(
  snapshot: OverviewSnapshot,
  utilization: UtilizationTotals
): Promise<AttentionItem[]> {
  const items: AttentionItem[] = [];
  const { nodes, containersByNode } = snapshot;
  const now = Date.now();

  for (const node of nodes) {
    if (!node.isActive) continue;
    if (node.offline) {
      items.push({
        severity: "critical",
        category: "node",
        title: `${node.name} is offline`,
        detail: node.lastHeartbeatAt
          ? `Last heartbeat ${timeAgo(node.lastHeartbeatAt)}.`
          : "No heartbeat recorded yet.",
        resourceType: "node",
        resourceId: node.id,
        nodeId: node.id
      });
    } else if (node.staleHeartbeat) {
      items.push({
        severity: "warning",
        category: "node",
        title: `${node.name} heartbeat is stale`,
        detail: `Last heartbeat ${timeAgo(node.lastHeartbeatAt!)}.`,
        resourceType: "node",
        resourceId: node.id,
        nodeId: node.id
      });
    }
  }

  const failedOps = await prisma.operation.findMany({
    where: { state: "FAILED", finishedAt: { gte: new Date(now - 24 * 3600_000) } },
    orderBy: { finishedAt: "desc" },
    take: 10,
    include: { node: { select: { id: true, name: true } } }
  });
  for (const op of failedOps) {
    items.push({
      severity: "warning",
      category: "operation",
      title: `${humanizeAction(op.type)} failed`,
      detail: op.error ?? "Unknown error",
      resourceType: "operation",
      resourceId: op.id,
      nodeId: op.nodeId
    });
  }

  for (const node of nodes) {
    if (node.offline) continue;
    const containers = containersByNode.get(node.id) ?? [];
    for (const c of containers) {
      if (c.status === "unhealthy") {
        items.push({
          severity: "critical",
          category: "container",
          title: `${c.name} is unhealthy`,
          detail: `On ${node.name}. Health check failing.`,
          resourceType: "container",
          resourceId: c.id,
          nodeId: node.id
        });
      } else if (c.status === "restarting" || (c.restartCount ?? 0) >= 3) {
        items.push({
          severity: "warning",
          category: "container",
          title: `${c.name} is crash-looping`,
          detail: `On ${node.name}. Restart count: ${c.restartCount ?? "?"}.`,
          resourceType: "container",
          resourceId: c.id,
          nodeId: node.id
        });
      } else if (c.status === "stopped") {
        items.push({
          severity: "info",
          category: "container",
          title: `${c.name} is stopped`,
          detail: `On ${node.name}.`,
          resourceType: "container",
          resourceId: c.id,
          nodeId: node.id
        });
      }
    }
  }

  return items.slice(0, 25);
}

export async function collectWorkloads(snapshot: OverviewSnapshot): Promise<WorkloadSummary[]> {
  const projects = await prisma.project.findMany({
    where: { isActive: true },
    include: {
      node: { select: { id: true, name: true } },
      clientAccount: { select: { id: true, name: true } },
      containers: { where: { isActive: true }, select: { dockerContainerId: true, dockerName: true } },
      _count: { select: { containers: true, grants: true } }
    }
  });

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
      if (c.status === "unhealthy") unhealthy += 1;
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
    const nodeOnline = node ? !node.offline : false;
    const health: WorkloadSummary["health"] = !nodeOnline
      ? "unknown"
      : unhealthy > 0
        ? "degraded"
        : running === total
          ? "healthy"
          : running === 0
            ? "down"
            : "degraded";

    const lastEvent = await prisma.auditLog.findFirst({
      where: { targetType: "PROJECT", targetId: project.id },
      orderBy: { createdAt: "desc" },
      select: { action: true, createdAt: true, result: true }
    });

    summaries.push({
      id: project.id,
      name: project.name,
      slug: project.slug,
      description: project.description,
      nodeId: project.nodeId,
      nodeName: project.node.name,
      clientId: project.clientAccount.id,
      clientName: project.clientAccount.name,
      totalContainers: total,
      runningContainers: running,
      stoppedContainers: stopped,
      unhealthyContainers: unhealthy,
      health,
      cpuPercent: cpuCount > 0 ? Number((cpuSum / cpuCount).toFixed(1)) : null,
      memoryUsage: memSum > 0 ? `${memSum.toFixed(0)} MiB` : null,
      lastEvent: lastEvent
        ? { action: lastEvent.action, createdAt: lastEvent.createdAt.toISOString(), result: lastEvent.result }
        : null
    });
  }

  return summaries.sort((a, b) => a.name.localeCompare(b.name));
}

function timeAgo(date: Date): string {
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
