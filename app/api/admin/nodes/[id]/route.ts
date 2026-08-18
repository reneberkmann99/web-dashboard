import { requireApiRole } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { updateNodeSchema, cuidParamSchema } from "@/server/validation/admin";
import { encryptSecret } from "@/server/security/crypto";
import { fromError, fail, ok } from "@/server/http";
import { logAuditEvent } from "@/server/audit";
import { getSourceIpFromRequest } from "@/server/request";
import { listContainersForNode } from "@/server/services/workloads";

export async function GET(
  _: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const id = cuidParamSchema.parse((await params).id);
    await requireApiRole("ADMIN");

    const node = await prisma.node.findUnique({
      where: { id },
      include: {
        projects: {
          where: { isActive: true },
          select: {
            id: true,
            name: true,
            slug: true,
            clientAccount: { select: { name: true } },
            _count: { select: { containers: true } }
          }
        },
        _count: { select: { containers: true, assignments: true } }
      }
    });
    if (!node) {
      return fail("NOT_FOUND", "Node not found", 404);
    }

    const containers = await listContainersForNode(node.id);
    const running = containers.filter((c) => c.status === "running").length;
    const unhealthy = containers.filter((c) => c.status === "unhealthy").length;

    const activity = await prisma.auditLog.findMany({
      where: { OR: [{ targetType: "NODE", targetId: node.id }, { metadata: { path: ["nodeId"], equals: node.id } }] },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: { id: true, action: true, actorEmail: true, result: true, createdAt: true }
    });

    return ok({
      node: {
        id: node.id,
        name: node.name,
        hostname: node.hostname,
        status: node.status,
        isActive: node.isActive,
        lastHeartbeatAt: node.lastHeartbeatAt,
        agentVersion: node.agentVersion,
        dockerVersion: node.dockerVersion,
        osInfo: node.osInfo,
        systemInfo: node.systemInfo,
        containerCount: containers.length,
        runningCount: running,
        unhealthyCount: unhealthy,
        projects: node.projects,
        counts: node._count
      },
      activity
    });
  } catch (error) {
    return fromError(error);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const session = await requireApiRole("ADMIN");
    const sourceIp = getSourceIpFromRequest(request);
    const id = cuidParamSchema.parse((await params).id);
    const body = updateNodeSchema.parse(await request.json());

    await prisma.node.update({
      where: { id },
      data: {
        name: body.name,
        hostname: body.hostname,
        apiBaseUrl: body.apiBaseUrl,
        dockerContext: body.dockerContext,
        isActive: body.isActive,
        ...(body.apiKey ? { apiKeyEncrypted: encryptSecret(body.apiKey) } : {})
      }
    });

    await logAuditEvent({
      actorUserId: session.userId,
      actorEmail: session.email,
      actorRole: session.role,
      action: "NODE_UPDATE",
      targetType: "NODE",
      targetId: id,
      metadata: {
        ...body,
        ...(body.apiKey ? { apiKey: "<redacted>" } : {})
      },
      result: "SUCCESS",
      sourceIp
    });

    return ok({ success: true });
  } catch (error) {
    return fromError(error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const session = await requireApiRole("ADMIN");
    const sourceIp = getSourceIpFromRequest(request);
    const id = cuidParamSchema.parse((await params).id);

    await prisma.node.update({
      where: { id },
      data: {
        isActive: false,
        status: "INACTIVE"
      }
    });

    await logAuditEvent({
      actorUserId: session.userId,
      actorEmail: session.email,
      actorRole: session.role,
      action: "NODE_DEACTIVATE",
      targetType: "NODE",
      targetId: id,
      result: "SUCCESS",
      sourceIp
    });

    return ok({ success: true });
  } catch (error) {
    return fromError(error);
  }
}
