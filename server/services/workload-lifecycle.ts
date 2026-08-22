import { Role } from "@prisma/client";
import { prisma } from "@/server/db";
import { logAuditEvent } from "@/server/audit";
import { nodeAgentClient } from "@/server/services/node-agent/client";
import { reconcileIngressEndpointsForDeactivatedWorkload } from "@/server/services/ingress";
import type { AuthSession } from "@/server/auth/session";

/**
 * Workload lifecycle (Section 13): deactivate / unmanage / delete are distinct
 * and never collapse into one ambiguous "Delete".
 *
 *  - deactivate : isActive=false — workload remains, client access disabled,
 *                 runtime Docker resources NOT touched, reversible.
 *  - remove from Noderaft (unmanage) : for COMPOSE workloads this is
 *                 `detachComposeTracking` (source→MANUAL); for MANUAL workloads
 *                 it is deactivate. Docker resources keep running.
 *  - delete : destructive. Removes workload containers via the agent
 *                 (`docker rm -f`, named volumes PRESERVED — the agent never
 *                 passes `-v`), then hard-deletes the Project row. Audit history
 *                 survives. Managed workloads (Deployment present) are refused —
 *                 the schema RESTRICTs their deletion by design; they must be
 *                 deactivated or removed-from-management first.
 */

export class WorkloadLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkloadLifecycleError";
  }
}

export type WorkloadDeletionPlan = {
  projectId: string;
  name: string;
  nodeId: string;
  managed: boolean;
  containers: Array<{ id: string; dockerContainerId: string; dockerName: string; image: string | null }>;
  grants: Array<{ id: string; clientAccountName: string }>;
  namedVolumesPreserved: boolean;
  networksPreserved: boolean;
  releaseHistoryPreserved: boolean;
};

/**
 * Build a human-visible deletion plan (read-only) so the confirmation dialog
 * can state exactly what will happen before anything is mutated.
 */
export async function buildWorkloadDeletionPlan(projectId: string): Promise<WorkloadDeletionPlan | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      containers: { where: { isActive: true }, select: { id: true, dockerContainerId: true, dockerName: true, image: true } },
      grants: { where: { isActive: true }, select: { id: true, clientAccount: { select: { name: true } } } },
      deployment: { select: { id: true } }
    }
  });
  if (!project) return null;

  return {
    projectId: project.id,
    name: project.name,
    nodeId: project.nodeId,
    managed: Boolean(project.deployment),
    containers: project.containers,
    grants: project.grants.map((g) => ({ id: g.id, clientAccountName: g.clientAccount.name })),
    namedVolumesPreserved: true,
    networksPreserved: true,
    releaseHistoryPreserved: true
  };
}

/**
 * Deactivate (isActive=false) or reactivate (isActive=true) a workload.
 * Pure DB toggle — never touches Docker. Reversible.
 */
export async function setWorkloadActive(
  session: AuthSession,
  projectId: string,
  isActive: boolean,
  sourceIp: string | null
): Promise<{ id: string; name: string }> {
  if (session.role !== Role.ADMIN) {
    throw new WorkloadLifecycleError("FORBIDDEN");
  }

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) {
    throw new WorkloadLifecycleError("NOT_FOUND");
  }

  await prisma.project.update({ where: { id: projectId }, data: { isActive } });

  if (!isActive) {
    await reconcileIngressEndpointsForDeactivatedWorkload(projectId);
  }

  await logAuditEvent({
    actorUserId: session.userId,
    actorEmail: session.email,
    actorRole: session.role,
    action: isActive ? "WORKLOAD_ACTIVATE" : "WORKLOAD_DEACTIVATE",
    targetType: "PROJECT",
    targetId: projectId,
    metadata: { name: project.name },
    result: "SUCCESS",
    sourceIp
  });

  return { id: project.id, name: project.name };
}

/**
 * Destructive workload delete. Refuses managed workloads. Removes workload
 * containers via the agent (volumes preserved), then hard-deletes the Project.
 */
export async function deleteWorkload(
  session: AuthSession,
  projectId: string,
  sourceIp: string | null
): Promise<WorkloadDeletionPlan> {
  if (session.role !== Role.ADMIN) {
    throw new WorkloadLifecycleError("FORBIDDEN");
  }

  const plan = await buildWorkloadDeletionPlan(projectId);
  if (!plan) {
    throw new WorkloadLifecycleError("NOT_FOUND");
  }

  if (plan.managed) {
    throw new WorkloadLifecycleError("MANAGED_WORKLOAD");
  }

  // 1. Remove containers through the agent (best-effort per container; a
  //    single offline agent must not block the metadata removal, and named
  //    volumes are never removed — the agent never passes `-v`).
  const node = await prisma.node.findUnique({ where: { id: plan.nodeId } });
  const removedContainers: string[] = [];
  if (node) {
    for (const c of plan.containers) {
      const ok = await nodeAgentClient.removeContainer(node, c.dockerContainerId);
      if (ok) removedContainers.push(c.dockerContainerId);
    }
  }

  // 2. Hard-delete the Project. Grants cascade; containers SetNull (they're
  //    already removed from Docker and will be marked inactive by the next
  //    inventory refresh). Audit/Activity survives via snapshots + the
  //    explicit WORKLOAD_DELETE event written below.
  await prisma.project.delete({ where: { id: projectId } });

  await logAuditEvent({
    actorUserId: session.userId,
    actorEmail: session.email,
    actorRole: session.role,
    action: "WORKLOAD_DELETE",
    targetType: "PROJECT",
    targetId: projectId,
    metadata: {
      name: plan.name,
      containersRemoved: removedContainers,
      containerCount: plan.containers.length,
      namedVolumesPreserved: true,
      networksPreserved: true
    },
    result: "SUCCESS",
    sourceIp
  });

  return plan;
}
