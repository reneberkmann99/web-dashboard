import { Node } from "@prisma/client";
import { prisma } from "@/server/db";
import { nodeAgentClient } from "@/server/services/node-agent/client";
import { ATTENTION_CONFIG } from "@/server/services/attention-config";

/**
 * Single source of truth for node heartbeat/status transitions (§24).
 *
 * Previously this logic was duplicated (and subtly inconsistent) across
 * `overview.ts` and `containers.ts` — each independently decided whether a
 * failed poll should immediately flip a node to OFFLINE. Centralizing it
 * here means every page (Overview, Nodes, node detail, container list)
 * agrees on the same ONLINE/STALE/OFFLINE state from the same grace-period
 * policy, and a single change to thresholds (attention-config.ts) affects
 * the whole app.
 */
export type HeartbeatState = "ONLINE" | "STALE" | "OFFLINE";

export type NodePollResult = {
  status: string;
  lastHeartbeatAt: Date | null;
  heartbeatState: HeartbeatState;
  agentVersion: string | null;
  dockerVersion: string | null;
  systemInfo: Record<string, unknown> | null;
};

export function resolveHeartbeatState(status: string, lastHeartbeatAt: Date | null, now = Date.now()): HeartbeatState {
  const ageMs = lastHeartbeatAt ? now - lastHeartbeatAt.getTime() : Infinity;
  if (status === "OFFLINE" || status === "UNKNOWN" || ageMs > ATTENTION_CONFIG.heartbeat.offlineAfterMs) return "OFFLINE";
  if (ageMs > ATTENTION_CONFIG.heartbeat.staleAfterMs) return "STALE";
  return "ONLINE";
}

/**
 * Record the outcome of a single inventory poll against `node` and return
 * the resolved heartbeat state. Persists a status transition to the DB only
 * when the effective state actually changes (ONLINE on success; OFFLINE only
 * once the last known-good heartbeat exceeds the hard threshold — a single
 * dropped poll does not flip the node to OFFLINE).
 */
export async function recordNodePoll(
  node: Node,
  polledOnline: boolean
): Promise<NodePollResult> {
  const { staleAfterMs, offlineAfterMs } = ATTENTION_CONFIG.heartbeat;
  const now = new Date();

  let status: string = node.status;
  let lastHeartbeatAt: Date | null = node.lastHeartbeatAt;
  let agentVersion = node.agentVersion;
  let dockerVersion = node.dockerVersion;
  let systemInfo = node.systemInfo as Record<string, unknown> | null;

  if (polledOnline) {
    const nodeInfo = await nodeAgentClient.getNodeInfo(node).catch(() => ({}) as Awaited<ReturnType<typeof nodeAgentClient.getNodeInfo>>);
    agentVersion = nodeInfo.agentVersion ?? agentVersion;
    dockerVersion = nodeInfo.dockerVersion ?? dockerVersion;
    systemInfo = (nodeInfo.systemInfo as Record<string, unknown>) ?? systemInfo;
    await prisma.node
      .update({
        where: { id: node.id },
        data: {
          status: "ONLINE",
          lastHeartbeatAt: now,
          agentVersion: nodeInfo.agentVersion ?? undefined,
          dockerVersion: nodeInfo.dockerVersion ?? undefined,
          composeSupported: nodeInfo.composeSupported ?? undefined,
          composeVersion: nodeInfo.composeVersion ?? undefined,
          osInfo: (nodeInfo.osInfo as object) ?? undefined,
          systemInfo: (nodeInfo.systemInfo as object) ?? undefined
        }
      })
      .catch(() => undefined);
    status = "ONLINE";
    lastHeartbeatAt = now;
  } else if (node.status !== "INACTIVE") {
    const heartbeatAgeMs = lastHeartbeatAt ? now.getTime() - lastHeartbeatAt.getTime() : Infinity;
    if (heartbeatAgeMs > offlineAfterMs) {
      if (node.status !== "OFFLINE") {
        await prisma.node.update({ where: { id: node.id }, data: { status: "OFFLINE" } }).catch(() => undefined);
      }
      status = "OFFLINE";
    }
    // else: keep the previously persisted status (grace period — a single
    // dropped poll never immediately marks a node offline).
  }

  const heartbeatState = resolveHeartbeatState(status, lastHeartbeatAt, now.getTime());

  return { status, lastHeartbeatAt, heartbeatState, agentVersion, dockerVersion, systemInfo };
}
