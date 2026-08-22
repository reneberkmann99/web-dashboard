import { Role } from "@prisma/client";
import { lockContainerForUpdate, prisma } from "@/server/db";
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

  // Deletion here is a SOFT delete (isActive: false) — the row and its
  // foreign keys survive, so an IngressEndpoint.containerId relation would
  // silently keep pointing at a backend that's gone (Docker) but still
  // "exists" (row), with nothing to reconcile it automatically. Refuse
  // instead, the same way a managed workload service is refused — the
  // endpoint must be deleted or repointed first (see server/services/ingress.ts).
  //
  // The check and the isActive flip happen together, under a lock on this
  // Container row (server/db.ts's lockContainerForUpdate — the SAME lock
  // createIngressEndpoint/updateIngressEndpoint take before attaching a
  // container), and BEFORE the external agent call: a plain pre-transaction
  // check here would leave a window where a concurrent endpoint attach could
  // land between this read and the eventual isActive write, leaving a live
  // endpoint pointed at a container this function is about to remove. Since
  // the isActive flip has never been gated on the agent call actually
  // succeeding (see `removed` below — recorded, not required), moving it
  // earlier doesn't change that existing behavior.
  await prisma.$transaction(async (tx) => {
    await lockContainerForUpdate(tx, containerId);
    const boundEndpoint = await tx.ingressEndpoint.findFirst({ where: { containerId }, select: { id: true } });
    if (boundEndpoint) {
      throw new ContainerLifecycleError("CONTAINER_HAS_INGRESS_ENDPOINT");
    }
    await tx.container.update({ where: { id: containerId }, data: { isActive: false } });
  });

  const node = await prisma.node.findUnique({ where: { id: plan.nodeId } });
  let removed = false;
  if (node) {
    removed = await nodeAgentClient.removeContainer(node, plan.dockerContainerId);
  }

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
