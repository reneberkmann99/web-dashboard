import { prisma } from "@/server/db";
import { nodeAgentClient } from "@/server/services/node-agent/client";
import type { AttentionItem, WorkloadSummary } from "@/types/domain";

/**
 * Overview + Workloads data assembly for the operations dashboards.
 */

const STALE_HEARTBEAT_MS = 5 * 60 * 1000; // no heartbeat in 5 minutes = stale

export type UtilizationTotals = {
  cpuPercent: number | null;
  memoryUsage: string | null;
  memoryBytes: number | null;
  totalContainers: number;
  runningContainers: number;
  stoppedContainers: number;
  unhealthyContainers: number;
  restartingContainers: number;
};

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

export async function collectNodesOperational(): Promise<NodeOperationalView[]> {
  const nodes = await prisma.node.findMany({ orderBy: { name: "asc" } });
  const views: NodeOperationalView[] = [];

  for (const node of nodes) {
    let containerCount = 0;
    let runningCount = 0;
    try {
      const payload = await nodeAgentClient.listContainers(node);
      containerCount = payload.containers.length;
      runningCount = payload.containers.filter((c) => c.status === "running").length;
      if (payload.nodeOnline) {
        await prisma.node
          .update({
            where: { id: node.id },
            data: { status: "ONLINE", lastHeartbeatAt: new Date() }
          })
          .catch(() => undefined);
        node.status = "ONLINE";
        node.lastHeartbeatAt = new Date();
      }
    } catch {
      // agent unreachable — keep stored state
    }
    const offline = node.status === "OFFLINE" || node.status === "UNKNOWN";
    const staleHeartbeat =
      !!node.lastHeartbeatAt && Date.now() - node.lastHeartbeatAt.getTime() > STALE_HEARTBEAT_MS;

    views.push({
      id: node.id,
      name: node.name,
      hostname: node.hostname,
      status: node.status,
      isActive: node.isActive,
      lastHeartbeatAt: node.lastHeartbeatAt,
      agentVersion: node.agentVersion,
      dockerVersion: node.dockerVersion,
      containerCount,
      runningCount,
      offline,
      staleHeartbeat
    });
  }

  return views;
}

export async function collectUtilization(): Promise<UtilizationTotals> {
  const nodes = await prisma.node.findMany({ where: { isActive: true } });
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
  let memBytes = 0;
  let measured = 0;

  for (const node of nodes) {
    try {
      const payload = await nodeAgentClient.listContainers(node);
      totals.totalContainers += payload.containers.length;
      for (const c of payload.containers) {
        if (c.status === "running") totals.runningContainers += 1;
        if (c.status === "stopped") totals.stoppedContainers += 1;
        if (c.status === "unhealthy") totals.unhealthyContainers += 1;
        if (c.status === "restarting") totals.restartingContainers += 1;
        if (typeof c.cpuPercent === "number") {
          cpuSum += c.cpuPercent;
          measured += 1;
        }
        if (typeof c.memoryUsage === "string" && c.memoryUsage.includes("MiB")) {
          const raw = c.memoryUsage.split("/")[0]?.trim().replace("MiB", "");
          const mb = Number(raw);
          if (!Number.isNaN(mb)) {
            memBytes += mb * 1024 * 1024;
          }
        }
      }
    } catch {
      // node offline — skip
    }
  }

  totals.cpuPercent = measured > 0 ? Number((cpuSum / measured).toFixed(1)) : null;
  totals.memoryBytes = memBytes;
  totals.memoryUsage = memBytes > 0 ? `${(memBytes / 1024 / 1024 / 1024).toFixed(2)} GiB` : null;
  return totals;
}

/**
 * Compute the "Needs attention" list. Only returns items when something is
 * actually wrong — a healthy system yields an empty array and the UI hides
 * the section entirely.
 */
export async function collectAttentionItems(): Promise<AttentionItem[]> {
  const items: AttentionItem[] = [];
  const nodes = await collectNodesOperational();
  const utilization = await collectUtilization();
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

  // Failed operations in the last 24h.
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

  // Container-level issues come from the agents.
  const nodesOnline = nodes.filter((n) => !n.offline);
  for (const node of nodesOnline) {
    try {
      const nodeRow = await prisma.node.findUnique({ where: { id: node.id } });
      if (!nodeRow) continue;
      const payload = await nodeAgentClient.listContainers(nodeRow);
      for (const c of payload.containers) {
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
            detail: `On ${node.name}. ${c.uptime ?? "Not running"}.`,
            resourceType: "container",
            resourceId: c.id,
            nodeId: node.id
          });
        }
      }
    } catch {
      // skip unreachable nodes (already flagged)
    }
  }

  // Severe utilization: any single container above 90% CPU.
  if (utilization.cpuPercent !== null && utilization.cpuPercent > 90) {
    items.push({
      severity: "warning",
      category: "resource",
      title: `High CPU utilization (${utilization.cpuPercent}%)`,
      detail: "A container is saturating a CPU core.",
      resourceType: "container",
      resourceId: null,
      nodeId: null
    });
  }

  // Cap for readability.
  return items.slice(0, 25);
}

export async function collectWorkloads(): Promise<WorkloadSummary[]> {
  const projects = await prisma.project.findMany({
    where: { isActive: true },
    include: {
      node: { select: { id: true, name: true } },
      clientAccount: { select: { id: true, name: true } },
      containers: {
        where: { isActive: true },
        select: { dockerContainerId: true, dockerName: true, lastKnownStatus: true }
      },
      _count: { select: { containers: true, grants: true } }
    }
  });

  const summaries: WorkloadSummary[] = [];
  for (const project of projects) {
    // Live statuses from the node agent.
    const node = await prisma.node.findUnique({ where: { id: project.nodeId } });
    let running = 0;
    let stopped = 0;
    let unhealthy = 0;
    let cpuSum = 0;
    let cpuCount = 0;
    let memSum = 0;
    let nodeOnline = false;

    if (node) {
      try {
        const payload = await nodeAgentClient.listContainers(node);
        nodeOnline = payload.nodeOnline;
        const live = payload.containers;
        for (const c of live) {
          const inProject = project.containers.some((pc) => pc.dockerContainerId === c.id);
          if (!inProject) continue;
          if (c.status === "running") running += 1;
          if (c.status === "stopped") stopped += 1;
          if (c.status === "unhealthy") unhealthy += 1;
          if (typeof c.cpuPercent === "number") {
            cpuSum += c.cpuPercent;
            cpuCount += 1;
          }
          if (typeof c.memoryUsage === "string") {
            const raw = c.memoryUsage.split("/")[0]?.trim().replace("MiB", "");
            const mb = Number(raw);
            if (!Number.isNaN(mb)) memSum += mb;
          }
        }
      } catch {
        nodeOnline = false;
      }
    }

    const total = project.containers.length;
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
      where: {
        OR: [
          { targetType: "PROJECT", targetId: project.id },
          { action: { in: ["ASSIGNMENT_CREATE", "GRANT_CREATE", "GRANT_UPDATE"] } }
        ]
      },
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

export function humanizeAction(action: string): string {
  const map: Record<string, string> = {
    CONTAINER_RESTART: "Restarted container",
    CONTAINER_START: "Started container",
    CONTAINER_STOP: "Stopped container",
    LOGIN_SUCCESS: "Signed in",
    LOGIN_FAILED: "Failed sign-in",
    USER_CREATE: "Created user",
    USER_UPDATE: "Updated user",
    CLIENT_CREATE: "Created client",
    CLIENT_UPDATE: "Updated client",
    CLIENT_DEACTIVATE: "Deactivated client",
    PROJECT_CREATE: "Created workload",
    PROJECT_UPDATE: "Updated workload",
    PROJECT_DEACTIVATE: "Deactivated workload",
    ASSIGNMENT_CREATE: "Granted container access",
    ASSIGNMENT_UPDATE: "Updated container grant",
    ASSIGNMENT_DELETE: "Revoked container access",
    GRANT_CREATE: "Granted access",
    GRANT_UPDATE: "Updated grant",
    GRANT_DEACTIVATE: "Revoked grant",
    NODE_CREATE: "Registered node",
    NODE_UPDATE: "Updated node",
    NODE_DEACTIVATE: "Disabled node",
    NODE_ENROLLED: "Enrolled node",
    NODE_ENROLLMENT_TOKEN_CREATED: "Created enrollment token",
    NODE_ENROLL_FAILED: "Node enrollment failed",
    LOGOUT: "Signed out",
    ACCOUNT_ACTIVATED: "Activated account",
    ACCOUNT_ACTIVATE_FAILED: "Account activation failed",
    LOGIN_RATE_LIMITED: "Sign-in rate limited"
  };
  if (map[action]) {
    return map[action];
  }
  // Fall back to stripping prefixes and lowercasing: CONTAINER_RESTART_REQUESTED -> Restart requested
  const cleaned = action
    .replace(/^CONTAINER_/, "")
    .replace(/_REQUESTED$/, " requested")
    .replace(/_SUCCEEDED$/, " succeeded")
    .replace(/_FAILED$/, " failed");
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
}

function timeAgo(date: Date): string {
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
