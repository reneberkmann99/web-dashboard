import { prisma } from "@/server/db";
import { logAuditEvent } from "@/server/audit";
import type { AuthSession } from "@/server/auth/session";

/**
 * Client→node allowlist for tenant self-service (Phase 7).
 * Admin-managed; clients may only create workloads on allowed nodes.
 */

export type ClientNodeAccessView = {
  nodeId: string;
  name: string;
  hostname: string;
  status: string;
  composeSupported: boolean | null;
  composeVersion: string | null;
  transportMode: string;
  isActive: boolean;
};

export async function listClientNodeAccess(clientAccountId: string): Promise<ClientNodeAccessView[]> {
  const rows = await prisma.clientNodeAccess.findMany({
    where: { clientAccountId },
    include: {
      node: {
        select: {
          id: true,
          name: true,
          hostname: true,
          status: true,
          composeSupported: true,
          composeVersion: true,
          transportMode: true,
          isActive: true
        }
      }
    },
    orderBy: { createdAt: "asc" }
  });
  return rows.map((r) => ({
    nodeId: r.node.id,
    name: r.node.name,
    hostname: r.node.hostname,
    status: r.node.status,
    composeSupported: r.node.composeSupported,
    composeVersion: r.node.composeVersion,
    transportMode: r.node.transportMode,
    isActive: r.node.isActive
  }));
}

export async function setClientNodeAccess(input: {
  clientAccountId: string;
  nodeIds: string[];
  actor: AuthSession;
  sourceIp?: string | null;
}): Promise<{ status: "updated"; nodeIds: string[] } | { status: "client_not_found" } | { status: "node_not_found"; nodeId: string }> {
  const client = await prisma.clientAccount.findUnique({ where: { id: input.clientAccountId } });
  if (!client) return { status: "client_not_found" };

  const uniqueIds = Array.from(new Set(input.nodeIds));
  if (uniqueIds.length > 0) {
    const nodes = await prisma.node.findMany({
      where: { id: { in: uniqueIds } },
      select: { id: true }
    });
    const found = new Set(nodes.map((n) => n.id));
    for (const id of uniqueIds) {
      if (!found.has(id)) return { status: "node_not_found", nodeId: id };
    }
  }

  await prisma.$transaction([
    prisma.clientNodeAccess.deleteMany({ where: { clientAccountId: input.clientAccountId } }),
    ...(uniqueIds.length > 0
      ? [prisma.clientNodeAccess.createMany({ data: uniqueIds.map((nodeId) => ({ clientAccountId: input.clientAccountId, nodeId })) })]
      : [])
  ]);

  await logAuditEvent({
    actorUserId: input.actor.userId,
    actorEmail: input.actor.email,
    actorRole: input.actor.role,
    action: "CLIENT_NODE_ACCESS_UPDATED",
    targetType: "CLIENT",
    targetId: input.clientAccountId,
    metadata: { nodeIds: uniqueIds },
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null
  });

  return { status: "updated", nodeIds: uniqueIds };
}

/** Nodes a CLIENT session is allowed to deploy on (active + compose-capable). */
export async function listAllowedNodesForClient(clientAccountId: string): Promise<ClientNodeAccessView[]> {
  return (await listClientNodeAccess(clientAccountId)).filter((n) => n.isActive);
}
