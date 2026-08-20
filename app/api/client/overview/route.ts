import { requireApiRole } from "@/server/auth/guards";
import { buildOverview, listContainersForSession } from "@/server/services/containers";
import { prisma } from "@/server/db";
import { collectOverviewSnapshot, collectWorkloads, humanizeAction } from "@/server/services/overview";
import { syncAttentionIfDue, getAttentionFeedForClient } from "@/server/services/attention";
import { fromError, ok } from "@/server/http";

/**
 * Client dashboard: "are my services healthy? what changed recently?"
 * Scoped entirely to the caller's grants and client account. Never exposes
 * fleet-wide node issues, other clients, or admin-only deployment internals
 * (§18) — the attention feed here is workload-only and grant-scoped.
 */
export async function GET(): Promise<Response> {
  try {
    const session = await requireApiRole("CLIENT");
    const clientId = session.clientAccountId ?? "__invalid__";

    const containers = await listContainersForSession(session);
    const overview = buildOverview(containers);

    // Workload health — only workloads this client can see.
    const grantedProjectIds = await prisma.accessGrant.findMany({
      where: { clientAccountId: clientId, isActive: true, projectId: { not: null } },
      select: { projectId: true }
    });
    const idSet = new Set(grantedProjectIds.map((g) => g.projectId).filter((v): v is string => !!v));

    const snapshot = await collectOverviewSnapshot();
    await syncAttentionIfDue(snapshot);
    const allWorkloads = await collectWorkloads(snapshot);
    const workloads = allWorkloads.filter((w) => w.clientId === clientId || (w.id && idSet.has(w.id)));
    const attention = await getAttentionFeedForClient(clientId);

    const [recentActivity, containerOperations, deploymentOperations] = await Promise.all([
      prisma.auditLog.findMany({
        where: { clientAccountId: clientId },
        orderBy: { createdAt: "desc" },
        take: 8,
        select: { id: true, action: true, actorEmail: true, result: true, createdAt: true, targetType: true }
      }),
      prisma.operation.findMany({
        where: { clientAccountId: clientId, state: { in: ["REQUESTED", "QUEUED", "RUNNING"] } },
        orderBy: { requestedAt: "desc" },
        take: 10,
        select: { id: true, type: true, state: true, container: { select: { projectId: true, dockerName: true } } }
      }),
      prisma.deploymentOperation.findMany({
        where: {
          state: { in: ["REQUESTED", "QUEUED", "RUNNING"] },
          deployment: { project: { clientAccountId: clientId } }
        },
        orderBy: { requestedAt: "desc" },
        take: 10,
        select: { id: true, type: true, state: true, deployment: { select: { projectId: true, project: { select: { name: true } } } } }
      })
    ]);

    const activeOperations = [
      ...containerOperations.map((op) => ({
        id: op.id,
        type: op.type,
        state: op.state,
        targetName: op.container?.dockerName ?? "container",
        href: op.container?.projectId ? `/client/workloads/${op.container.projectId}` : null
      })),
      ...deploymentOperations.map((op) => ({
        id: op.id,
        type: op.type,
        state: op.state,
        targetName: op.deployment.project.name,
        href: `/client/workloads/${op.deployment.projectId}`
      }))
    ];

    return ok({
      overview,
      workloads,
      attention,
      activeOperations,
      recentActivity: recentActivity.map((a) => ({ ...a, humanized: humanizeAction(a.action) })),
      recentContainers: containers.slice(0, 8)
    });
  } catch (error) {
    return fromError(error);
  }
}
