import { prisma } from "@/server/db";
import { ensureCan, type Capability } from "@/server/auth/policy";
import type { AuthSession } from "@/server/auth/session";

/**
 * Tenant-scoped access helpers for the client deployment lifecycle (Phase 7).
 *
 * Policy: lifecycle operations are available for workloads OWNED by the
 * caller's client account. Grants (cross-client access) remain view/operate
 * only — they never allow managing another tenant's deployment.
 */

export type ClientDeploymentContext = {
  deploymentId: string;
  projectId: string;
  composeProjectName: string;
  nodeId: string;
  runtimeState: string;
  currentReleaseId: string | null;
  lastHealthyReleaseId: string | null;
};

export async function getClientDeployment(
  session: AuthSession,
  deploymentId: string,
  capability: Capability
): Promise<ClientDeploymentContext | null> {
  if (!session.clientAccountId) return null;
  const deployment = await prisma.deployment.findUnique({
    where: { id: deploymentId },
    select: {
      id: true,
      composeProjectName: true,
      runtimeState: true,
      currentReleaseId: true,
      lastHealthyReleaseId: true,
      project: { select: { id: true, clientAccountId: true, nodeId: true } }
    }
  });
  if (!deployment) return null;
  if (deployment.project.clientAccountId !== session.clientAccountId) return null;
  ensureCan(session, capability);
  return {
    deploymentId: deployment.id,
    projectId: deployment.project.id,
    composeProjectName: deployment.composeProjectName,
    nodeId: deployment.project.nodeId,
    runtimeState: deployment.runtimeState,
    currentReleaseId: deployment.currentReleaseId,
    lastHealthyReleaseId: deployment.lastHealthyReleaseId
  };
}

/** Thin wrapper: throw FORBIDDEN/NOT_FOUND so routes stay minimal. */
export async function requireClientDeployment(
  session: AuthSession,
  deploymentId: string,
  capability: Capability
): Promise<ClientDeploymentContext> {
  const ctx = await getClientDeployment(session, deploymentId, capability);
  if (!ctx) throw new Error("NOT_FOUND");
  return ctx;
}

export async function listClientDeploymentOperations(deploymentId: string, take = 50) {
  const ops = await prisma.deploymentOperation.findMany({
    where: { deploymentId },
    orderBy: { requestedAt: "desc" },
    take,
    select: {
      id: true,
      type: true,
      state: true,
      phase: true,
      revisionId: true,
      actorEmail: true,
      error: true,
      requestedAt: true,
      startedAt: true,
      finishedAt: true
    }
  });
  return ops.map((op) => ({
    id: op.id,
    type: op.type,
    state: op.state,
    phase: op.phase,
    revisionId: op.revisionId,
    actorEmail: op.actorEmail,
    error: op.error,
    requestedAt: op.requestedAt.toISOString(),
    startedAt: op.startedAt?.toISOString() ?? null,
    finishedAt: op.finishedAt?.toISOString() ?? null
  }));
}

export async function getClientDeploymentOperation(deploymentId: string, operationId: string) {
  const op = await prisma.deploymentOperation.findFirst({
    where: { id: operationId, deploymentId },
    select: {
      id: true,
      type: true,
      state: true,
      phase: true,
      revisionId: true,
      actorEmail: true,
      error: true,
      result: true,
      requestedAt: true,
      startedAt: true,
      finishedAt: true
    }
  });
  if (!op) return null;
  return {
    id: op.id,
    type: op.type,
    state: op.state,
    phase: op.phase,
    revisionId: op.revisionId,
    actorEmail: op.actorEmail,
    error: op.error,
    result: op.result,
    requestedAt: op.requestedAt.toISOString(),
    startedAt: op.startedAt?.toISOString() ?? null,
    finishedAt: op.finishedAt?.toISOString() ?? null
  };
}
