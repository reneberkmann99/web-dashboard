import { prisma } from "@/server/db";

/**
 * Resolve Activity/audit-log target ids to human display names — the primary
 * Activity UI must never show a raw cuid (design review round 2, §3/§8/§9).
 *
 * Node, Container, and ClientAccount rows are never hard-deleted (they're
 * deactivated via `isActive`), so a live lookup always resolves them. Project
 * (workload) and User rows CAN be hard-deleted; for those, fall back to the
 * name snapshot every delete path already writes into `metadata` and mark
 * the row `deleted` so the UI can render "Main VPS (deleted)".
 */

export type ActivityLogLike = { targetType: string; targetId: string | null; metadata: unknown };
export type ResolvedTarget = { label: string | null; deleted: boolean };

function metadataString(metadata: unknown, keys: string[]): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const record = metadata as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

const NODE_META_KEYS = ["nodeName"];
const WORKLOAD_META_KEYS = ["name", "workloadName", "projectName"];
const CONTAINER_META_KEYS = ["dockerName", "containerName"];
const CLIENT_META_KEYS = ["name", "clientName"];
const USER_META_KEYS = ["deletedDisplayName", "deletedEmail", "displayName", "email"];

/** True nodeId:dockerContainerId cuid never contains a colon; attention-derived CONTAINER audit rows use that composite as resourceId while direct container-lifecycle actions use the Container row's own cuid — both occur in the wild. */
function splitCompositeContainerId(targetId: string): { nodeId: string; dockerContainerId: string } | null {
  const idx = targetId.indexOf(":");
  if (idx === -1) return null;
  return { nodeId: targetId.slice(0, idx), dockerContainerId: targetId.slice(idx + 1) };
}

export async function resolveActivityTargetLabels(logs: ActivityLogLike[]): Promise<Map<string, ResolvedTarget>> {
  const idsByType = new Map<string, Set<string>>();
  for (const log of logs) {
    if (!log.targetId) continue;
    const set = idsByType.get(log.targetType) ?? new Set<string>();
    set.add(log.targetId);
    idsByType.set(log.targetType, set);
  }

  const containerIds = [...(idsByType.get("CONTAINER") ?? [])];
  const containerPlainIds = containerIds.filter((id) => !splitCompositeContainerId(id));
  const containerComposites = containerIds.map(splitCompositeContainerId).filter((v): v is NonNullable<typeof v> => v !== null);

  const [nodes, projects, containersByPlainId, containersByComposite, clients, users] = await Promise.all([
    idsByType.has("NODE")
      ? prisma.node.findMany({ where: { id: { in: [...idsByType.get("NODE")!] } }, select: { id: true, name: true } })
      : Promise.resolve([]),
    idsByType.has("PROJECT") || idsByType.has("WORKLOAD")
      ? prisma.project.findMany({
          where: { id: { in: [...(idsByType.get("PROJECT") ?? []), ...(idsByType.get("WORKLOAD") ?? [])] } },
          select: { id: true, name: true }
        })
      : Promise.resolve([]),
    containerPlainIds.length > 0
      ? prisma.container.findMany({ where: { id: { in: containerPlainIds } }, select: { id: true, dockerName: true } })
      : Promise.resolve([]),
    containerComposites.length > 0
      ? prisma.container.findMany({ where: { OR: containerComposites }, select: { nodeId: true, dockerContainerId: true, dockerName: true } })
      : Promise.resolve([]),
    idsByType.has("CLIENT") || idsByType.has("ORGANIZATION")
      ? prisma.clientAccount.findMany({
          where: { id: { in: [...(idsByType.get("CLIENT") ?? []), ...(idsByType.get("ORGANIZATION") ?? [])] } },
          select: { id: true, name: true }
        })
      : Promise.resolve([]),
    idsByType.has("USER")
      ? prisma.user.findMany({ where: { id: { in: [...idsByType.get("USER")!] } }, select: { id: true, displayName: true, email: true } })
      : Promise.resolve([])
  ]);

  const nodeById = new Map(nodes.map((n) => [n.id, n.name]));
  const projectById = new Map(projects.map((p) => [p.id, p.name]));
  const containerById = new Map(containersByPlainId.map((c) => [c.id, c.dockerName]));
  const containerByComposite = new Map(containersByComposite.map((c) => [`${c.nodeId}:${c.dockerContainerId}`, c.dockerName]));
  const clientById = new Map(clients.map((c) => [c.id, c.name]));
  const userById = new Map(users.map((u) => [u.id, u.displayName || u.email]));

  const out = new Map<string, ResolvedTarget>();
  for (const log of logs) {
    if (!log.targetId) continue;
    const key = `${log.targetType}:${log.targetId}`;
    if (out.has(key)) continue;

    let resolved: ResolvedTarget;
    switch (log.targetType) {
      case "NODE": {
        // Nodes are deactivated, never hard-deleted — a miss is unresolved
        // metadata, not evidence of deletion.
        const live = nodeById.get(log.targetId);
        resolved = { label: live ?? metadataString(log.metadata, NODE_META_KEYS), deleted: false };
        break;
      }
      case "PROJECT":
      case "WORKLOAD": {
        // Workloads CAN be hard-deleted (workload-lifecycle.ts) — a miss here
        // really does mean gone.
        const live = projectById.get(log.targetId);
        resolved = live ? { label: live, deleted: false } : { label: metadataString(log.metadata, WORKLOAD_META_KEYS), deleted: true };
        break;
      }
      case "CONTAINER": {
        // Containers are deactivated, never hard-deleted.
        const live = containerById.get(log.targetId) ?? containerByComposite.get(log.targetId);
        resolved = { label: live ?? metadataString(log.metadata, CONTAINER_META_KEYS), deleted: false };
        break;
      }
      case "CLIENT":
      case "ORGANIZATION": {
        // Organizations are deactivated, never hard-deleted.
        const live = clientById.get(log.targetId);
        resolved = { label: live ?? metadataString(log.metadata, CLIENT_META_KEYS), deleted: false };
        break;
      }
      case "USER": {
        // Users CAN be hard-deleted (user-lifecycle.ts) — a miss here really
        // does mean gone; the delete path writes a name snapshot to metadata.
        const live = userById.get(log.targetId);
        resolved = live ? { label: live, deleted: false } : { label: metadataString(log.metadata, USER_META_KEYS), deleted: true };
        break;
      }
      default:
        resolved = { label: metadataString(log.metadata, ["resourceName", "targetName", "displayName", "name"]), deleted: false };
    }
    out.set(key, resolved);
  }
  return out;
}
