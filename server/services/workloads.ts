import { prisma } from "@/server/db";
import { nodeAgentClient } from "@/server/services/node-agent/client";
import type { RuntimeContainer } from "@/server/services/node-agent/types";
import { humanizeAction } from "@/server/services/overview";

/**
 * Workload (Project/Stack) detail assembly.
 */

export async function listContainersForNode(nodeId: string): Promise<RuntimeContainer[]> {
  const node = await prisma.node.findUnique({ where: { id: nodeId } });
  if (!node) return [];
  try {
    const payload = await nodeAgentClient.listContainers(node);
    return payload.containers;
  } catch {
    return [];
  }
}

export type WorkloadDetail = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  node: { id: string; name: string; hostname: string; status: string };
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
    node: { id: string; name: string; hostname: string; status: string };
    clientAccount: { id: string; name: string; slug: string };
    grants: Array<{ id: string; allowedActions: string[]; clientAccount: { name: string } }>;
    containers: Array<{ dockerContainerId: string; dockerName: string }>;
  },
  liveContainers: RuntimeContainer[]
): WorkloadDetail {
  const projectIds = new Set(project.containers.map((c) => c.dockerContainerId));

  const containerSummaries = liveContainers.map((c) => ({
    containerId: c.id,
    dockerName: c.name,
    status: c.status,
    cpuPercent: c.cpuPercent,
    memoryUsage: c.memoryUsage,
    restartCount: c.restartCount,
    ports: c.ports,
    uptime: c.uptime,
    health: c.details?.health ?? null,
    inProject: projectIds.has(c.id)
  }));

  const inProject = containerSummaries.filter((c) => c.inProject);
  const running = inProject.filter((c) => c.status === "running").length;
  const stopped = inProject.filter((c) => c.status === "stopped").length;
  const unhealthy = inProject.filter((c) => c.status === "unhealthy").length;
  const total = inProject.length;

  const health: WorkloadDetail["health"] =
    project.node.status === "ONLINE"
      ? unhealthy > 0
        ? "degraded"
        : running === total
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
    node: project.node,
    client: { id: project.clientAccount.id, name: project.clientAccount.name, slug: project.clientAccount.slug },
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
    cpuPercent: cpuCount > 0 ? Number((cpuSum / cpuCount).toFixed(1)) : null,
    memoryUsage: memSum > 0 ? `${memSum.toFixed(0)} MiB` : null,
    exposedPorts
  };
}

export { humanizeAction };
