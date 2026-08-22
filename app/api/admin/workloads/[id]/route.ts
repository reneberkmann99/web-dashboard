import { requireApiRole } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { cuidParamSchema, updateProjectSchema } from "@/server/validation/admin";
import { fail, fromError, ok } from "@/server/http";
import { listContainersForNode, toWorkloadDetail } from "@/server/services/workloads";
import { getAdminWorkloadDeploymentStatus } from "@/server/services/deployments";
import { getAttentionFeedForAdmin, getExpectedStates } from "@/server/services/attention";
import { logAuditEvent } from "@/server/audit";
import { getSourceIpFromRequest } from "@/server/request";
import { deleteWorkload } from "@/server/services/workload-lifecycle";
import { assertWorkloadReassignable, reconcileIngressEndpointsForDeactivatedWorkload } from "@/server/services/ingress";
import { lockProjectForUpdate } from "@/server/db";

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
    const expectedStates = await getExpectedStates([project.node.id]);
    const detail = toWorkloadDetail(project, containers, expectedStates);

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

/**
 * PATCH /api/admin/workloads/:id — edit general settings (name/slug/description/
 * client/node) and deactivate/reactivate. Pure DB; never mutates Docker.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const session = await requireApiRole("ADMIN");
    const sourceIp = getSourceIpFromRequest(request);
    const id = cuidParamSchema.parse((await params).id);
    const body = updateProjectSchema.parse(await request.json());

    const target = await prisma.project.findUnique({ where: { id } });
    if (!target) {
      return fail("NOT_FOUND", "Workload not found", 404);
    }

    // Reassigning a workload to a different organization while it still has
    // ingress endpoints would leave those endpoints' clientAccountId (fixed
    // at create time) pointing at the OLD organization while
    // IngressEndpoint.workloadId now resolves through to the new one's
    // containers — letting the old tenant keep managing (and routing public
    // traffic into) a workload it no longer owns. Reassignment must never
    // silently orphan that ownership; force the endpoints to be dealt with
    // first, the same way domain/address/provider deletion is blocked while
    // still referenced. The check-then-update runs under the Project row
    // lock (see server/db.ts's lockProjectForUpdate doc comment) so a
    // concurrent createIngressEndpoint can't insert a fresh endpoint between
    // the check and the reassignment.
    const isReassignment = body.clientAccountId !== undefined && body.clientAccountId !== target.clientAccountId;
    await prisma.$transaction(async (tx) => {
      if (isReassignment) {
        await lockProjectForUpdate(tx, id);
        await assertWorkloadReassignable(id, tx);
      }

      await tx.project.update({
        where: { id },
        data: {
          name: body.name,
          slug: body.slug,
          description: body.description,
          clientAccountId: body.clientAccountId,
          isActive: body.isActive
        }
      });
    });

    // A deactivated workload's containers are no longer a valid ingress
    // backend — reconcile any bound endpoints the same way an explicit
    // workload-lifecycle deactivation does (see
    // reconcileIngressEndpointsForDeactivatedWorkload's doc comment). Only on
    // the true->false transition, after the update commits.
    if (body.isActive === false && target.isActive) {
      await reconcileIngressEndpointsForDeactivatedWorkload(id);
    }

    await logAuditEvent({
      actorUserId: session.userId,
      actorEmail: session.email,
      actorRole: session.role,
      action: "WORKLOAD_UPDATE",
      targetType: "PROJECT",
      targetId: id,
      metadata: { ...body },
      result: "SUCCESS",
      sourceIp
    });

    return ok({ success: true });
  } catch (error) {
    return fromError(error);
  }
}

/**
 * DELETE /api/admin/workloads/:id — destructive delete. Managed workloads are
 * refused (remove-from-management first). Otherwise removes containers via the
 * agent (volumes preserved) and hard-deletes the workload record.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const session = await requireApiRole("ADMIN");
    const sourceIp = getSourceIpFromRequest(request);
    const id = cuidParamSchema.parse((await params).id);

    const plan = await deleteWorkload(session, id, sourceIp);
    return ok({ deleted: true, id: plan.projectId, name: plan.name, containersRemoved: plan.containers.length });
  } catch (error) {
    return fromError(error);
  }
}
