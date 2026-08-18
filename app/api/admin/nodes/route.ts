import { requireApiRole } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { createNodeSchema } from "@/server/validation/admin";
import { encryptSecret } from "@/server/security/crypto";
import { fromError, ok } from "@/server/http";
import { logAuditEvent } from "@/server/audit";
import { getSourceIpFromRequest } from "@/server/request";
import { collectOverviewSnapshot } from "@/server/services/overview";

export async function GET(): Promise<Response> {
  try {
    await requireApiRole("ADMIN");

    const snapshot = await collectOverviewSnapshot();
    const live = new Map(snapshot.nodes.map((n) => [n.id, n]));

    const nodes = await prisma.node.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        hostname: true,
        apiBaseUrl: true,
        status: true,
        isActive: true,
        agentVersion: true,
        dockerVersion: true,
        lastHeartbeatAt: true,
        osInfo: true,
        systemInfo: true,
        _count: { select: { assignments: true } }
      }
    });

    return ok({
      nodes: nodes.map((n) => {
        const op = live.get(n.id);
        return {
          ...n,
          status: op?.status ?? n.status,
          lastHeartbeatAt: op?.lastHeartbeatAt ?? n.lastHeartbeatAt,
          liveContainerCount: op?.containerCount ?? 0,
          liveRunningCount: op?.runningCount ?? 0,
          staleHeartbeat: op?.staleHeartbeat ?? false
        };
      })
    });
  } catch (error) {
    return fromError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await requireApiRole("ADMIN");
    const sourceIp = getSourceIpFromRequest(request);

    const body = createNodeSchema.parse(await request.json());

    const created = await prisma.node.create({
      data: {
        name: body.name,
        hostname: body.hostname,
        apiBaseUrl: body.apiBaseUrl,
        apiKeyEncrypted: encryptSecret(body.apiKey),
        dockerContext: body.dockerContext,
        isActive: body.isActive ?? true,
        status: "UNKNOWN"
      }
    });

    await logAuditEvent({
      actorUserId: session.userId,
      actorEmail: session.email,
      actorRole: session.role,
      action: "NODE_CREATE",
      targetType: "NODE",
      targetId: created.id,
      metadata: { hostname: created.hostname, apiBaseUrl: created.apiBaseUrl },
      result: "SUCCESS",
      sourceIp
    });

    return ok({ id: created.id }, 201);
  } catch (error) {
    return fromError(error);
  }
}
