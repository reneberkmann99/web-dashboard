import { requireApiRole } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { updateNodeSchema, cuidParamSchema } from "@/server/validation/admin";
import { encryptSecret } from "@/server/security/crypto";
import { fromError, fail, ok } from "@/server/http";
import { logAuditEvent } from "@/server/audit";
import { getSourceIpFromRequest } from "@/server/request";
import { pollContainersForNode } from "@/server/services/workloads";
import { nodeAgentClient } from "@/server/services/node-agent/client";
import { getAttentionMap, getAttentionFeedForAdmin } from "@/server/services/attention";

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

    // pollContainersForNode polls the agent and refreshes node.status/
    // systemInfo via the centralized heartbeat policy; re-read afterward so
    // this response reflects the fresh values, not the pre-poll snapshot.
    const poll = await pollContainersForNode(node.id);
    const containers = poll.containers;
    const freshNode = await prisma.node.findUnique({ where: { id } });
    const running = containers.filter((c) => c.status === "running").length;
    const unhealthy = containers.filter((c) => c.health === "unhealthy" || c.status === "unhealthy").length;
    const stopped = containers.filter((c) => c.status === "stopped").length;
    const storageSummary = await nodeAgentClient.getStorageSummary(node);

    const [activity, attentionMap, attentionFeed] = await Promise.all([
      prisma.auditLog.findMany({
        where: { OR: [{ targetType: "NODE", targetId: node.id }, { metadata: { path: ["nodeId"], equals: node.id } }] },
        orderBy: { createdAt: "desc" },
        take: 30,
        select: { id: true, action: true, actorEmail: true, result: true, createdAt: true }
      }),
      getAttentionMap(),
      getAttentionFeedForAdmin()
    ]);

    const effectiveNode = freshNode ?? node;
    const offline = effectiveNode.status === "OFFLINE" || effectiveNode.status === "UNKNOWN";
    const attention = attentionMap.get(`NODE:${node.id}`) ?? (offline ? "critical" : "healthy");
    const nodeAttentionItems = attentionFeed.filter((item) => item.nodeId === node.id);

    return ok({
      node: {
        id: node.id,
        name: node.name,
        hostname: node.hostname,
        apiBaseUrl: node.apiBaseUrl,
        dockerContext: node.dockerContext,
        status: effectiveNode.status,
        heartbeatState: poll.heartbeatState,
        telemetryCurrent: poll.polledOnline,
        isActive: node.isActive,
        lastHeartbeatAt: effectiveNode.lastHeartbeatAt,
        agentVersion: effectiveNode.agentVersion,
        dockerVersion: effectiveNode.dockerVersion,
        createdAt: node.createdAt,
        osInfo: effectiveNode.osInfo,
        systemInfo: effectiveNode.systemInfo,
        containerCount: containers.length,
        runningCount: running,
        unhealthyCount: unhealthy,
        stoppedCount: stopped,
        storageSummary,
        attention,
        projects: node.projects,
        counts: node._count
      },
      attentionItems: nodeAttentionItems,
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
