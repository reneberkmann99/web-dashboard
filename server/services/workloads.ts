import { prisma } from "@/server/db";
import { nodeAgentClient } from "@/server/services/node-agent/client";
import type { RuntimeContainer } from "@/server/services/node-agent/types";
import { humanizeAction } from "@/server/services/overview";
import { requestOperation, OperationConflictError } from "@/server/services/operations";
import { recordNodePoll } from "@/server/services/node-heartbeat";
import type { AuthSession } from "@/server/auth/session";

/**
 * Workload (Project/Stack) detail assembly.
 */

export async function listContainersForNode(nodeId: string): Promise<RuntimeContainer[]> {
  return (await pollContainersForNode(nodeId)).containers;
}

export async function pollContainersForNode(nodeId: string): Promise<{
  containers: RuntimeContainer[];
  polledOnline: boolean;
  heartbeatState: import("@/server/services/node-heartbeat").HeartbeatState;
}> {
  const node = await prisma.node.findUnique({ where: { id: nodeId } });
  if (!node) return { containers: [], polledOnline: false, heartbeatState: "OFFLINE" };
  try {
    const payload = await nodeAgentClient.listContainers(node);
    // Keep heartbeat/systemInfo fresh on every viewing of this node's
    // containers (node detail, workload detail) — same centralized policy
    // used by Overview/Nodes (§21: don't reimplement this per caller).
    const poll = await recordNodePoll(node, payload.nodeOnline);
    return { containers: payload.containers, polledOnline: payload.nodeOnline, heartbeatState: poll.heartbeatState };
  } catch {
    const poll = await recordNodePoll(node, false);
    return { containers: [], polledOnline: false, heartbeatState: poll.heartbeatState };
  }
}

export type WorkloadDetail = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  source: string;
  composeProject: string | null;
  node: { id: string; name: string; hostname: string; status: string };
  /** Null when this is an internal workload with no owning client yet. */
  client: { id: string; name: string; slug: string } | null;
  grants: Array<{ id: string; allowedActions: string[]; clientName: string }>;
  containerSummaries: Array<{
    containerId: string;
    dockerName: string;
    status: string;
    cpuPercent: number | null;
    memoryUsage: string | null;
    restartCount: number | null;
    ports: string;
    uptime: string | null;
    health: string | null;
    inProject: boolean;
  }>;
  health: "healthy" | "degraded" | "down" | "unknown";
  totalContainers: number;
  runningContainers: number;
  stoppedContainers: number;
  unhealthyContainers: number;
  restartingContainers: number;
  cpuPercent: number | null;
  memoryUsage: string | null;
  exposedPorts: string[];
};

export function toWorkloadDetail(
  project: {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    source: string;
    composeProject: string | null;
    node: { id: string; name: string; hostname: string; status: string };
    clientAccount: { id: string; name: string; slug: string } | null;
    grants: Array<{ id: string; allowedActions: string[]; clientAccount: { name: string } }>;
    containers: Array<{ dockerContainerId: string; dockerName: string }>;
  },
  liveContainers: RuntimeContainer[]
): WorkloadDetail {
  const projectIds = new Set(project.containers.map((c) => c.dockerContainerId));

  // Only this workload's containers — never a node-wide dump. A container
  // belongs to the workload when its DB Container row is linked to the project
  // (projectId): COMPOSE workloads sync membership from compose labels,
  // MANUAL workloads attach explicitly (container detail / grants workflow).
  const containerSummaries = liveContainers
    .map((c) => ({
      containerId: c.id,
      dockerName: c.name,
      status: c.status,
      cpuPercent: c.cpuPercent,
      memoryUsage: c.memoryUsage,
      restartCount: c.restartCount,
      ports: c.ports,
      uptime: c.uptime,
      health: c.health ?? c.details?.health ?? null,
      inProject: projectIds.has(c.id)
    }))
    .filter((c) => c.inProject);

  const inProject = containerSummaries.filter((c) => c.inProject);
  const running = inProject.filter((c) => c.status === "running").length;
  const stopped = inProject.filter((c) => c.status === "stopped").length;
  const unhealthy = inProject.filter((c) => c.health === "unhealthy" || c.status === "unhealthy").length;
  const restarting = inProject.filter((c) => c.status === "restarting").length;
  const total = inProject.length;

  const health: WorkloadDetail["health"] =
    project.node.status === "ONLINE"
      ? unhealthy > 0
        ? "degraded"
        : total > 0 && running === total
          ? "healthy"
          : running === 0
            ? "down"
            : "degraded"
      : "unknown";

  const cpuSum = inProject.reduce((acc, c) => acc + (c.cpuPercent ?? 0), 0);
  const cpuCount = inProject.filter((c) => c.cpuPercent !== null).length;
  const memSum = inProject.reduce((acc, c) => {
    const raw = c.memoryUsage?.split("/")[0]?.trim().replace("MiB", "");
    const mb = Number(raw);
    return acc + (Number.isNaN(mb) ? 0 : mb);
  }, 0);

  const exposedPorts = Array.from(
    new Set(
      inProject
        .flatMap((c) => c.ports.split(",").map((p) => p.trim()).filter((p) => p.includes("->")))
        .map((p) => p.split("->")[0].trim())
    )
  ).slice(0, 20);

  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    description: project.description,
    source: project.source,
    composeProject: project.composeProject,
    node: project.node,
    client: project.clientAccount
      ? { id: project.clientAccount.id, name: project.clientAccount.name, slug: project.clientAccount.slug }
      : null,
    grants: project.grants.map((g) => ({
      id: g.id,
      allowedActions: g.allowedActions,
      clientName: g.clientAccount.name
    })),
    containerSummaries,
    health,
    totalContainers: total,
    runningContainers: running,
    stoppedContainers: stopped,
    unhealthyContainers: unhealthy,
    restartingContainers: restarting,
    cpuPercent: cpuCount > 0 ? Number((cpuSum / cpuCount).toFixed(1)) : null,
    memoryUsage: memSum > 0 ? `${memSum.toFixed(0)} MiB` : null,
    exposedPorts
  };
}

export { humanizeAction };

/**
 * Restart every active container in a workload as a set of tracked Operations.
 * Each container restart is an independent CONTAINER_RESTART operation (so the
 * existing conflict protection and lifecycle apply per container). Partial
 * failures are reported explicitly — never masked as a blanket success.
 * ADMIN-only (the route enforces the capability).
 */
export async function restartWorkload(
  projectId: string,
  session: AuthSession
): Promise<{
  total: number;
  operationIds: string[];
  failures: Array<{ dockerName: string; reason: string }>;
} | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { containers: { where: { isActive: true } } }
  });
  if (!project) {
    return null;
  }

  const operationIds: string[] = [];
  const failures: Array<{ dockerName: string; reason: string }> = [];

  for (const container of project.containers) {
    try {
      const opId = await requestOperation({
        type: "CONTAINER_RESTART",
        actor: session,
        clientAccountId: session.clientAccountId,
        nodeId: container.nodeId,
        dockerContainerId: container.dockerContainerId,
        containerId: container.id,
        sourceIp: null
      });
      operationIds.push(opId);
    } catch (error) {
      if (error instanceof OperationConflictError) {
        failures.push({ dockerName: container.dockerName, reason: "An operation is already in progress" });
      } else {
        failures.push({ dockerName: container.dockerName, reason: "Failed to request restart" });
      }
    }
  }

  return { total: project.containers.length, operationIds, failures };
}
