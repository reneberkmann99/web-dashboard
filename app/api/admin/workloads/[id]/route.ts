import { requireApiRole } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { cuidParamSchema } from "@/server/validation/admin";
import { fail, fromError, ok } from "@/server/http";
import { listContainersForNode, toWorkloadDetail } from "@/server/services/workloads";
import { getAdminWorkloadDeploymentStatus } from "@/server/services/deployments";
import { getAttentionFeedForAdmin } from "@/server/services/attention";

export async function GET(
  _: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const id = cuidParamSchema.parse((await params).id);
    await requireApiRole("ADMIN");

    const project = await prisma.project.findUnique({
      where: { id },
      include: {
        node: { select: { id: true, name: true, hostname: true, status: true } },
        clientAccount: { select: { id: true, name: true, slug: true } },
        grants: { where: { isActive: true }, select: { id: true, allowedActions: true, clientAccount: { select: { name: true } } } },
        containers: { where: { isActive: true }, select: { dockerContainerId: true, dockerName: true } }
      }
    });
    if (!project) {
      return fail("NOT_FOUND", "Workload not found", 404);
    }

    const containers = await listContainersForNode(project.node.id);
    const detail = toWorkloadDetail(project, containers);

    const activity = await prisma.auditLog.findMany({
      where: {
        OR: [
          { targetType: "PROJECT", targetId: project.id },
          { action: { in: ["ASSIGNMENT_CREATE", "ASSIGNMENT_DELETE", "GRANT_CREATE", "GRANT_DEACTIVATE"] } }
        ]
      },
      orderBy: { createdAt: "desc" },
      take: 25,
      select: { id: true, action: true, actorEmail: true, result: true, createdAt: true, metadata: true }
    });

    const now = new Date();
    const [deployment, attentionFeed, activeOperations, maintenance] = await Promise.all([
      getAdminWorkloadDeploymentStatus(project.id),
      getAttentionFeedForAdmin(),
      prisma.operation.findMany({
        where: {
          nodeId: project.node.id,
          dockerContainerId: { in: project.containers.map((c) => c.dockerContainerId) },
          state: { in: ["REQUESTED", "QUEUED", "RUNNING"] }
        },
        orderBy: { requestedAt: "desc" },
        select: { id: true, type: true, state: true, dockerContainerId: true, requestedAt: true }
      }),
      prisma.maintenanceWindow.findMany({
        where: {
          cancelledAt: null,
          startsAt: { lte: now },
          endsAt: { gt: now },
          OR: [{ workloadId: project.id }, { nodeId: project.node.id }]
        },
        orderBy: { endsAt: "asc" },
        select: { id: true, scope: true, startsAt: true, endsAt: true, reason: true, notificationBehavior: true }
      })
    ]);
    const memberContainerIds = new Set(project.containers.map((c) => `${project.node.id}:${c.dockerContainerId}`));
    const attentionItems = attentionFeed.filter(
      (item) =>
        (item.resourceType === "workload" && item.resourceId === project.id) ||
        (item.resourceType === "container" && item.resourceId && memberContainerIds.has(item.resourceId))
    );

    return ok({ workload: detail, activity, deployment, attentionItems, activeOperations, maintenance });
  } catch (error) {
    return fromError(error);
  }
}
