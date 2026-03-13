/**
 * Container service — primary business-logic layer.
 *
 * Security invariants:
 *  - CLIENT sessions are automatically scoped to their `clientAccountId`
 *    via the Prisma WHERE clause built in `buildWhereClause()`.
 *  - ADMIN sessions omit the client filter, granting full cross-client access.
 *  - Every action mutation is audited through `logAuditEvent`.
 *
 * Callers MUST validate session and role *before* invoking these functions
 * (enforced by the `requireApiRole` guard in each route handler).
 */
import { ContainerAssignment, Prisma, Role } from "@prisma/client";
import { prisma } from "@/server/db";
import { logAuditEvent } from "@/server/audit";
import { type AuthSession } from "@/server/auth/session";
import { nodeAgentClient } from "@/server/services/node-agent/client";
import { ContainerView, OverviewStats } from "@/types/domain";

function mapStatus(value?: string): ContainerView["status"] {
  if (!value) {
    return "unknown";
  }

  const normalized = value.toLowerCase();
  if (normalized.includes("unhealthy")) {
    return "unhealthy";
  }
  if (normalized.includes("restart")) {
    return "restarting";
  }
  if (normalized.includes("running")) {
    return "running";
  }
  if (normalized.includes("stop") || normalized.includes("exited")) {
    return "stopped";
  }
  return "unknown";
}

function toContainerView(
  assignment: ContainerAssignment & {
    node: { id: string; name: string };
    project: { name: string } | null;
    clientAccount: { name: string };
  },
  runtime: {
    id: string;
    name: string;
    image: string;
    status: ContainerView["status"];
    uptime: string | null;
    ports: string;
    createdAt: string | null;
    cpuPercent: number | null;
    memoryUsage: string | null;
    restartCount: number | null;
    lastUpdatedAt: string;
  } | null,
  nodeOnline: boolean
): ContainerView {
  return {
    assignmentId: assignment.id,
    containerId: assignment.dockerContainerId,
    name: assignment.friendlyLabel ?? runtime?.name ?? assignment.dockerName,
    image: runtime?.image ?? assignment.image ?? "unknown",
    status: runtime?.status ?? "unknown",
    uptime: runtime?.uptime ?? null,
    ports: runtime?.ports ?? "-",
    createdAt: runtime?.createdAt ?? null,
    cpuPercent: runtime?.cpuPercent ?? null,
    memoryUsage: runtime?.memoryUsage ?? null,
    restartCount: runtime?.restartCount ?? null,
    nodeId: assignment.nodeId,
    nodeName: assignment.node.name,
    nodeOnline,
    projectName: assignment.project?.name ?? null,
    clientName: assignment.clientAccount.name,
    allowedActions: assignment.allowedActions,
    lastUpdatedAt: runtime?.lastUpdatedAt ?? new Date().toISOString()
  };
}

async function getAssignmentsForSession(session: AuthSession) {
  const where: Prisma.ContainerAssignmentWhereInput = {
    isActive: true,
    ...(session.role === Role.CLIENT
      ? {
          clientAccountId: session.clientAccountId ?? "__invalid__"
        }
      : {})
  };

  return prisma.containerAssignment.findMany({
    where,
    include: {
      node: true,
      project: true,
      clientAccount: true
    },
    orderBy: { createdAt: "desc" }
  });
}

export async function listContainersForSession(session: AuthSession): Promise<ContainerView[]> {
  const assignments = await getAssignmentsForSession(session);
  const groupedByNode = new Map<string, typeof assignments>();

  for (const assignment of assignments) {
    const list = groupedByNode.get(assignment.nodeId) ?? [];
    list.push(assignment);
    groupedByNode.set(assignment.nodeId, list);
  }

  const results: ContainerView[] = [];

  for (const [, nodeAssignments] of groupedByNode) {
    const node = nodeAssignments[0].node;
    const runtimePayload = await nodeAgentClient.listContainers(node);
    await prisma.node
      .update({
        where: { id: node.id },
        data: {
          status: runtimePayload.nodeOnline ? "ONLINE" : "OFFLINE",
          lastHeartbeatAt: new Date()
        }
      })
      .catch(() => undefined);
    const runtimeMap = new Map(runtimePayload.containers.map((entry) => [entry.id, entry]));

    for (const assignment of nodeAssignments) {
      const live = runtimeMap.get(assignment.dockerContainerId);
      const mapped = live
        ? {
            ...live,
            status: mapStatus(live.status)
          }
        : null;
      results.push(toContainerView(assignment, mapped, runtimePayload.nodeOnline));
    }
  }

  return results;
}

export async function getContainerByAssignmentId(
  session: AuthSession,
  assignmentId: string
): Promise<ContainerView | null> {
  const assignment = await prisma.containerAssignment.findFirst({
    where: {
      id: assignmentId,
      isActive: true,
      ...(session.role === Role.CLIENT
        ? { clientAccountId: session.clientAccountId ?? "__invalid__" }
        : {})
    },
    include: {
      node: true,
      project: true,
      clientAccount: true
    }
  });

  if (!assignment) {
    return null;
  }

  const runtime = await nodeAgentClient.getContainer(assignment.node, assignment.dockerContainerId);
  return toContainerView(
    assignment,
    runtime.container
      ? {
          ...runtime.container,
          status: mapStatus(runtime.container.status)
        }
      : null,
    runtime.nodeOnline
  );
}

export async function getContainerLogs(
  session: AuthSession,
  assignmentId: string,
  tail = 200
): Promise<{ logs: string[]; nodeOnline: boolean } | null> {
  const assignment = await prisma.containerAssignment.findFirst({
    where: {
      id: assignmentId,
      isActive: true,
      ...(session.role === Role.CLIENT
        ? { clientAccountId: session.clientAccountId ?? "__invalid__" }
        : {})
    },
    include: {
      node: true
    }
  });

  if (!assignment) {
    return null;
  }

  const logResponse = await nodeAgentClient.getLogs(assignment.node, assignment.dockerContainerId, tail);
  return logResponse;
}

export async function runContainerAction(
  session: AuthSession,
  assignmentId: string,
  action: "start" | "stop" | "restart",
  sourceIp: string | null
): Promise<boolean> {
  const assignment = await prisma.containerAssignment.findFirst({
    where: {
      id: assignmentId,
      isActive: true,
      ...(session.role === Role.CLIENT
        ? { clientAccountId: session.clientAccountId ?? "__invalid__" }
        : {})
    },
    include: {
      node: true,
      clientAccount: true
    }
  });

  if (!assignment) {
    return false;
  }

  if (!assignment.allowedActions.includes(action)) {
    await logAuditEvent({
      actorUserId: session.userId,
      actorEmail: session.email,
      actorRole: session.role,
      action: `CONTAINER_${action.toUpperCase()}`,
      targetType: "CONTAINER_ASSIGNMENT",
      targetId: assignmentId,
      metadata: { reason: "action_not_allowed" },
      result: "FAILURE",
      sourceIp
    });
    return false;
  }

  const success = await nodeAgentClient.runAction(
    assignment.node,
    assignment.dockerContainerId,
    action
  );

  await logAuditEvent({
    actorUserId: session.userId,
    actorEmail: session.email,
    actorRole: session.role,
    action: `CONTAINER_${action.toUpperCase()}`,
    targetType: "CONTAINER_ASSIGNMENT",
    targetId: assignment.id,
    metadata: {
      assignmentId: assignment.id,
      dockerContainerId: assignment.dockerContainerId,
      nodeId: assignment.nodeId,
      client: assignment.clientAccount.name
    },
    result: success ? "SUCCESS" : "FAILURE",
    sourceIp
  });

  return success;
}

export function buildOverview(containers: ContainerView[]): OverviewStats {
  const running = containers.filter((item) => item.status === "running").length;
  const stopped = containers.filter((item) => item.status === "stopped").length;
  const restarting = containers.filter((item) => item.status === "restarting").length;
  const unhealthy = containers.filter((item) => item.status === "unhealthy").length;
  const nodeKeys = new Map<string, boolean>();

  for (const container of containers) {
    nodeKeys.set(container.nodeId, container.nodeOnline);
  }

  const offlineNodes = Array.from(nodeKeys.values()).filter((isOnline) => !isOnline).length;
  const onlineNodes = Array.from(nodeKeys.values()).filter((isOnline) => isOnline).length;

  return {
    totalContainers: containers.length,
    runningContainers: running,
    stoppedContainers: stopped,
    restartingContainers: restarting,
    unhealthyContainers: unhealthy,
    offlineNodes,
    onlineNodes
  };
}
