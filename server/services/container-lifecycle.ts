import { Role } from "@prisma/client";
import { prisma } from "@/server/db";
import { logAuditEvent } from "@/server/audit";
import { nodeAgentClient } from "@/server/services/node-agent/client";
import type { AuthSession } from "@/server/auth/session";

/**
 * Container delete lifecycle (Section 14). Behavior depends on ownership:
 *
 *  - Managed workload service: refuse. Removing a service must go through the
 *    workload revision/deployment lifecycle (remove service → new revision →
 *    plan → deploy), never an ad-hoc `docker rm` that would create drift.
 *  - Standalone / adopted manual container: remove directly via the agent
 *    (`docker rm -f`, named volumes PRESERVED), then mark the Container row
 *    inactive. The Docker removal is always preceded by an explicit,
 *    confirmed, planned admin action upstream.
 */

export class ContainerLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainerLifecycleError";
  }
}

export type ContainerDeletePlan = {
  containerId: string;
  dockerContainerId: string;
  dockerName: string;
  image: string | null;
  nodeId: string;
  managed: boolean;
  workloadName: string | null;
  namedVolumesPreserved: boolean;
};

/** Read-only preview of what a container delete would do. */
export async function buildContainerDeletePlan(containerId: string): Promise<ContainerDeletePlan | null> {
  const container = await prisma.container.findUnique({
    where: { id: containerId },
    include: {
      project: { select: { id: true, name: true, deployment: { select: { id: true } } } }
    }
  });
  if (!container) return null;

  return {
    containerId: container.id,
    dockerContainerId: container.dockerContainerId,
    dockerName: container.dockerName,
    image: container.image,
    nodeId: container.nodeId,
    managed: Boolean(container.project?.deployment),
    workloadName: container.project?.name ?? null,
    namedVolumesPreserved: true
  };
}

/**
 * Delete a standalone container. Refuses managed-workload services.
 */
export async function deleteContainer(
  session: AuthSession,
  containerId: string,
  sourceIp: string | null
): Promise<ContainerDeletePlan> {
  if (session.role !== Role.ADMIN) {
    throw new ContainerLifecycleError("FORBIDDEN");
  }

  const plan = await buildContainerDeletePlan(containerId);
  if (!plan) {
    throw new ContainerLifecycleError("NOT_FOUND");
  }
  if (plan.managed) {
    throw new ContainerLifecycleError("MANAGED_CONTAINER");
  }

  const node = await prisma.node.findUnique({ where: { id: plan.nodeId } });
  let removed = false;
  if (node) {
    removed = await nodeAgentClient.removeContainer(node, plan.dockerContainerId);
  }

  // Mark the inventory row inactive (never hard-delete: grants/history retain
  // their reference, and a future inventory refresh would otherwise resurrect
  // the row as a "new" discovery).
  await prisma.container.update({ where: { id: containerId }, data: { isActive: false } });

  await logAuditEvent({
    actorUserId: session.userId,
    actorEmail: session.email,
    actorRole: session.role,
    action: "CONTAINER_DELETE",
    targetType: "CONTAINER",
    targetId: containerId,
    metadata: {
      dockerContainerId: plan.dockerContainerId,
      dockerName: plan.dockerName,
      removedViaAgent: removed,
      namedVolumesPreserved: true
    },
    result: removed ? "SUCCESS" : "FAILURE",
    sourceIp
  });

  return plan;
}
