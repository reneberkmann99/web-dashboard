import { requireApiRole } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { createGrantSchema } from "@/server/validation/admin";
import { fromError, ok, fail } from "@/server/http";
import { logAuditEvent } from "@/server/audit";
import { getSourceIpFromRequest } from "@/server/request";

export async function GET(): Promise<Response> {
  try {
    await requireApiRole("ADMIN");

    const grants = await prisma.accessGrant.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        clientAccount: { select: { id: true, name: true } },
        node: { select: { id: true, name: true } },
        project: { select: { id: true, name: true } },
        container: { select: { id: true, dockerContainerId: true, dockerName: true } }
      }
    });

    return ok({ grants });
  } catch (error) {
    return fromError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await requireApiRole("ADMIN");
    const sourceIp = getSourceIpFromRequest(request);

    const body = createGrantSchema.parse(await request.json());

    // Resolve the node for the grant target (project carries its node;
    // container carries its node).
    let nodeId: string;
    if (body.projectId) {
      const project = await prisma.project.findUnique({ where: { id: body.projectId } });
      if (!project) {
        return fail("NOT_FOUND", "Project not found", 404);
      }
      nodeId = project.nodeId;
    } else {
      const container = await prisma.container.findUnique({ where: { id: body.containerId! } });
      if (!container) {
        return fail("NOT_FOUND", "Container not found", 404);
      }
      nodeId = container.nodeId;
    }

    const created = await prisma.accessGrant.create({
      data: {
        clientAccountId: body.clientAccountId,
        nodeId,
        projectId: body.projectId ?? null,
        containerId: body.containerId ?? null,
        allowedActions: body.allowedActions,
        isActive: body.isActive ?? true
      }
    });

    await logAuditEvent({
      actorUserId: session.userId,
      actorEmail: session.email,
      actorRole: session.role,
      action: "GRANT_CREATE",
      targetType: "ACCESS_GRANT",
      targetId: created.id,
      metadata: {
        clientAccountId: created.clientAccountId,
        projectId: created.projectId,
        containerId: created.containerId,
        allowedActions: created.allowedActions
      },
      result: "SUCCESS",
      sourceIp
    });

    return ok({ id: created.id }, 201);
  } catch (error) {
    return fromError(error);
  }
}
