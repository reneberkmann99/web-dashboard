import { requireApiRole } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { createAssignmentSchema } from "@/server/validation/admin";
import { fromError, ok } from "@/server/http";
import { logAuditEvent } from "@/server/audit";
import { getSourceIpFromRequest } from "@/server/request";
import { listDiscoveredContainersForAdmin } from "@/server/services/containers";

export async function GET(): Promise<Response> {
  try {
    await requireApiRole("ADMIN");

    const [assignments, clients, nodes, projects, grants, discovered] = await Promise.all([
      prisma.containerAssignment.findMany({
        orderBy: { createdAt: "desc" },
        include: {
          clientAccount: { select: { id: true, name: true } },
          node: { select: { id: true, name: true } },
          project: { select: { id: true, name: true } }
        }
      }),
      prisma.clientAccount.findMany({ where: { isActive: true }, select: { id: true, name: true } }),
      prisma.node.findMany({ where: { isActive: true }, select: { id: true, name: true } }),
      prisma.project.findMany({ where: { isActive: true }, select: { id: true, name: true } }),
      prisma.accessGrant.findMany({
        orderBy: { createdAt: "desc" },
        include: {
          clientAccount: { select: { id: true, name: true } },
          node: { select: { id: true, name: true } },
          project: { select: { id: true, name: true } },
          container: { select: { id: true, dockerContainerId: true, dockerName: true } }
        }
      }),
      listDiscoveredContainersForAdmin()
    ]);

    return ok({ assignments, clients, nodes, projects, grants, discovered });
  } catch (error) {
    return fromError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await requireApiRole("ADMIN");
    const sourceIp = getSourceIpFromRequest(request);

    const body = createAssignmentSchema.parse(await request.json());

    // Ensure the Container inventory row exists (reference discovered objects).
    const container = await prisma.container.upsert({
      where: {
        nodeId_dockerContainerId: { nodeId: body.nodeId, dockerContainerId: body.dockerContainerId }
      },
      update: {
        dockerName: body.dockerName ?? undefined,
        image: body.image ?? undefined,
        lastSeenAt: new Date(),
        isActive: true
      },
      create: {
        nodeId: body.nodeId,
        dockerContainerId: body.dockerContainerId,
        dockerName: body.dockerName ?? body.dockerContainerId,
        image: body.image ?? null,
        projectId: body.projectId ?? null
      }
    });

    const created = await prisma.containerAssignment.create({
      data: {
        clientAccountId: body.clientAccountId,
        projectId: body.projectId ?? null,
        nodeId: body.nodeId,
        containerId: container.id,
        dockerContainerId: body.dockerContainerId,
        dockerName: body.dockerName ?? container.dockerName,
        image: body.image ?? container.image,
        friendlyLabel: body.friendlyLabel,
        allowedActions: body.allowedActions,
        isActive: true
      }
    });

    // Mirror into the unified AccessGrant model (container-level grant).
    await prisma.accessGrant
      .create({
        data: {
          clientAccountId: body.clientAccountId,
          nodeId: body.nodeId,
          containerId: container.id,
          allowedActions: body.allowedActions,
          isActive: true,
          metadata: { migratedFromAssignmentId: created.id }
        }
      })
      .catch(() => undefined); // unique (client, container) — already granted

    await logAuditEvent({
      actorUserId: session.userId,
      actorEmail: session.email,
      actorRole: session.role,
      action: "ASSIGNMENT_CREATE",
      targetType: "CONTAINER_ASSIGNMENT",
      targetId: created.id,
      metadata: body,
      result: "SUCCESS",
      sourceIp
    });

    return ok({ id: created.id }, 201);
  } catch (error) {
    return fromError(error);
  }
}
