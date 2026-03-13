import { requireApiRole } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { createAssignmentSchema } from "@/server/validation/admin";
import { fromError, ok } from "@/server/http";
import { logAuditEvent } from "@/server/audit";
import { getSourceIpFromRequest } from "@/server/request";

export async function GET(): Promise<Response> {
  try {
    const session = await requireApiRole("ADMIN");

    const [assignments, clients, nodes, projects] = await Promise.all([
      prisma.containerAssignment.findMany({
        orderBy: { createdAt: "desc" },
        include: {
          clientAccount: {
            select: {
              id: true,
              name: true
            }
          },
          node: {
            select: {
              id: true,
              name: true
            }
          },
          project: {
            select: {
              id: true,
              name: true
            }
          }
        }
      }),
      prisma.clientAccount.findMany({ where: { isActive: true }, select: { id: true, name: true } }),
      prisma.node.findMany({ where: { isActive: true }, select: { id: true, name: true } }),
      prisma.project.findMany({ where: { isActive: true }, select: { id: true, name: true } })
    ]);

    return ok({ assignments, clients, nodes, projects });
  } catch (error) {
    return fromError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await requireApiRole("ADMIN");
    const sourceIp = getSourceIpFromRequest(request);

    const body = createAssignmentSchema.parse(await request.json());

    const created = await prisma.containerAssignment.create({
      data: {
        clientAccountId: body.clientAccountId,
        projectId: body.projectId ?? null,
        nodeId: body.nodeId,
        dockerContainerId: body.dockerContainerId,
        dockerName: body.dockerName,
        image: body.image,
        friendlyLabel: body.friendlyLabel,
        allowedActions: body.allowedActions,
        isActive: true
      }
    });

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
