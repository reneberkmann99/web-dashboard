import { requireApiRole } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { createProjectSchema } from "@/server/validation/admin";
import { fromError, ok } from "@/server/http";
import { logAuditEvent } from "@/server/audit";
import { getSourceIpFromRequest } from "@/server/request";

export async function GET(): Promise<Response> {
  try {
    await requireApiRole("ADMIN");

    const projects = await prisma.project.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        node: { select: { id: true, name: true } },
        clientAccount: { select: { id: true, name: true } },
        _count: { select: { assignments: true, grants: true, containers: true } }
      }
    });

    return ok({ projects });
  } catch (error) {
    return fromError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await requireApiRole("ADMIN");
    const sourceIp = getSourceIpFromRequest(request);

    const body = createProjectSchema.parse(await request.json());
    const created = await prisma.project.create({
      data: {
        name: body.name,
        slug: body.slug,
        description: body.description ?? null,
        clientAccountId: body.clientAccountId,
        nodeId: body.nodeId,
        isActive: body.isActive ?? true
      }
    });

    await logAuditEvent({
      actorUserId: session.userId,
      actorEmail: session.email,
      actorRole: session.role,
      action: "PROJECT_CREATE",
      targetType: "PROJECT",
      targetId: created.id,
      metadata: { name: created.name, clientAccountId: created.clientAccountId, nodeId: created.nodeId },
      result: "SUCCESS",
      sourceIp
    });

    return ok({ id: created.id }, 201);
  } catch (error) {
    return fromError(error);
  }
}
