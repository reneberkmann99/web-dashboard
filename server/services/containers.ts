/**
 * Container service — primary business-logic layer.
 *
 * Security invariants:
 *  - CLIENT sessions are automatically scoped to their `clientAccountId` in
 *    every query (tenant isolation lives here, never in the frontend).
 *  - ADMIN sessions omit the client filter.
 *  - Visibility is computed from AccessGrant rows (project-level or
 *    container-level) plus legacy ContainerAssignment rows (pre-refactor).
 *  - Every action mutation is audited through `logAuditEvent`.
 */
import { Node, Prisma, Role } from "@prisma/client";
import { prisma } from "@/server/db";
import { logAuditEvent } from "@/server/audit";
import { type AuthSession } from "@/server/auth/session";
import { can, type Capability } from "@/server/auth/policy";
import { nodeAgentClient } from "@/server/services/node-agent/client";
import { recordNodePoll, type HeartbeatState } from "@/server/services/node-heartbeat";
import { getAttentionMap, syncAttentionIfDue, getExpectedStates, isExpectedRunning } from "@/server/services/attention";
import { collectOverviewSnapshot } from "@/server/services/overview";
import { reconcileIngressEndpointsForDeactivatedContainers } from "@/server/services/ingress";
import { ContainerView, OverviewStats, DiscoveredContainer } from "@/types/domain";

function mapStatus(value?: string): ContainerView["status"] {
  if (!value) {
    return "unknown";
  }

  const normalized = value.toLowerCase();
  if (normalized.includes("unhealthy")) {
    return "unhealthy";
  }
  if (normalized.includes("restart")) {
    return "restarting";
  }
  if (normalized.includes("running")) {
    return "running";
  }
  if (normalized.includes("stop") || normalized.includes("exited")) {
    return "stopped";
  }
  return "unknown";
}

type AssignmentWithRelations = Prisma.ContainerAssignmentGetPayload<{
  include: {
    node: { select: { id: true; name: true } };
    project: { select: { id: true; name: true } };
    clientAccount: { select: { id: true; name: true } };
  };
}>;

function toContainerView(
  assignment: AssignmentWithRelations,
  runtime: {
    id: string;
    name: string;
    image: string;
    status: ContainerView["status"];
    health?: ContainerView["health"];
    uptime: string | null;
    ports: string;
    createdAt: string | null;
    cpuPercent: number | null;
    memoryUsage: string | null;
    restartCount: number | null;
    restartPolicy?: string | null;
    lastUpdatedAt: string;
    details?: ContainerView["details"];
  } | null,
  nodeOnline: boolean
): ContainerView {
  return {
    assignmentId: assignment.id,
    containerId: assignment.dockerContainerId,
    name: assignment.friendlyLabel ?? runtime?.name ?? assignment.dockerName,
    image: runtime?.image ?? assignment.image ?? "unknown",
    status: runtime?.status ?? "unknown",
    health: runtime?.health ?? runtime?.details?.health as ContainerView["health"] ?? null,
    uptime: runtime?.uptime ?? null,
    ports: runtime?.ports ?? "-",
    createdAt: runtime?.createdAt ?? null,
    cpuPercent: runtime?.cpuPercent ?? null,
    memoryUsage: runtime?.memoryUsage ?? null,
    restartCount: runtime?.restartCount ?? null,
    restartPolicy: runtime?.restartPolicy ?? null,
    nodeId: assignment.nodeId,
    nodeName: assignment.node.name,
    nodeOnline,
    projectName: assignment.project?.name ?? null,
    projectId: assignment.project?.id ?? null,
    clientName: assignment.clientAccount.name,
    clientId: assignment.clientAccount.id,
    allowedActions: assignment.allowedActions,
    lastUpdatedAt: runtime?.lastUpdatedAt ?? new Date().toISOString(),
    details: runtime?.details ?? null
  };
}

/** Tenant scope predicate shared by every client-facing query. */
function tenantScope(session: AuthSession): Prisma.ContainerAssignmentWhereInput {
  return session.role === Role.ADMIN
    ? {}
    : { clientAccountId: session.clientAccountId ?? "__invalid__" };
}

type GrantContainerRow = {
  dockerContainerId: string;
  dockerName: string;
  image: string | null;
  friendlyLabel: string | null;
  allowedActions: string[];
  nodeId: string;
  node: { id: string; name: string };
  project: { id: string; name: string } | null;
  clientAccount: { id: string; name: string };
  grantId: string;
  /** Alternative ids that resolve to this row (legacy assignment ids). */
  aliasIds: string[];
};

/** Build an AssignmentWithRelations-shaped object from a resolved grant row. */
function grantToAssignment(row: GrantContainerRow): AssignmentWithRelations {
  return {
    id: row.grantId,
    clientAccountId: row.clientAccount.id,
    nodeId: row.nodeId,
    projectId: row.project?.id ?? null,
    dockerContainerId: row.dockerContainerId,
    dockerName: row.dockerName,
    image: row.image,
    friendlyLabel: row.friendlyLabel,
    allowedActions: row.allowedActions,
    isActive: true,
    containerId: null,
    metadata: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    node: row.node,
    project: row.project,
    clientAccount: row.clientAccount
  };
}

function rowMatchesGrant(row: GrantContainerRow, grantId: string): boolean {
  return row.grantId === grantId || row.aliasIds.includes(grantId);
}

/**
 * Resolve every container the session may see, with the effective allowed
 * actions for each. Sources:
 *   1. Legacy ContainerAssignment rows (pre-refactor grants).
 *   2. AccessGrant rows targeting a specific container.
 *   3. AccessGrant rows targeting a Project (its containers via
 *      Container.projectId), which also auto-includes containers granted to
 *      the project's client account.
 * Returns a de-duplicated map keyed by nodeId:dockerContainerId.
 */
export async function resolveVisibleContainersForSession(session: AuthSession): Promise<Map<string, GrantContainerRow>> {
  const result = new Map<string, GrantContainerRow>();
  const clientId = session.role === Role.ADMIN ? null : (session.clientAccountId ?? "__invalid__");

  // Tenant isolation: a session whose client account was deactivated sees
  // nothing, even if the user row is still active (the login gate catches
  // this too, but mid-session deactivation must also take effect).
  if (clientId) {
    const client = await prisma.clientAccount.findUnique({
      where: { id: clientId },
      select: { isActive: true }
    });
    if (!client?.isActive) {
      return result;
    }
  }

  const whereClient = clientId ? { clientAccountId: clientId } : {};

  const [assignments, containerGrants, projectGrants] = await Promise.all([
    prisma.containerAssignment.findMany({
      where: { isActive: true, ...whereClient },
      include: {
        node: { select: { id: true, name: true } },
        project: { select: { id: true, name: true } },
        clientAccount: { select: { id: true, name: true } }
      }
    }),
    prisma.accessGrant.findMany({
      where: { isActive: true, ...whereClient, projectId: null, containerId: { not: null } },
      include: {
        container: true,
        node: { select: { id: true, name: true } },
        project: { select: { id: true, name: true } },
        clientAccount: { select: { id: true, name: true } }
      }
    }),
    prisma.accessGrant.findMany({
      where: { isActive: true, ...whereClient, containerId: null, projectId: { not: null } },
      include: {
        project: { include: { containers: true } },
        node: { select: { id: true, name: true } },
        clientAccount: { select: { id: true, name: true } }
      }
    })
  ]);

  for (const a of assignments) {
    const key = `${a.nodeId}:${a.dockerContainerId}`;
    result.set(key, {
      dockerContainerId: a.dockerContainerId,
      dockerName: a.dockerName,
      image: a.image,
      friendlyLabel: a.friendlyLabel,
      allowedActions: a.allowedActions,
      nodeId: a.nodeId,
      node: a.node,
      project: a.project,
      clientAccount: a.clientAccount,
      grantId: a.id,
      aliasIds: [a.id]
    });
  }

  for (const g of containerGrants) {
    if (!g.container) continue;
    const key = `${g.nodeId}:${g.container.dockerContainerId}`;
    const existing = result.get(key);
    result.set(key, {
      dockerContainerId: g.container.dockerContainerId,
      dockerName: g.container.dockerName,
      image: g.container.image,
      friendlyLabel: existing?.friendlyLabel ?? null,
      allowedActions: existing
        ? Array.from(new Set([...existing.allowedActions, ...g.allowedActions]))
        : g.allowedActions,
      nodeId: g.nodeId,
      node: g.node,
      project: g.project ?? existing?.project ?? null,
      clientAccount: g.clientAccount,
      grantId: existing?.grantId ?? g.id,
      aliasIds: existing ? [...existing.aliasIds, g.id] : [g.id]
    });
  }

  for (const g of projectGrants) {
    if (!g.project) continue;
    for (const container of g.project.containers) {
      const key = `${g.nodeId}:${container.dockerContainerId}`;
      const existing = result.get(key);
      result.set(key, {
        dockerContainerId: container.dockerContainerId,
        dockerName: container.dockerName,
        image: container.image,
        friendlyLabel: existing?.friendlyLabel ?? null,
        allowedActions: existing
          ? Array.from(new Set([...existing.allowedActions, ...g.allowedActions]))
          : g.allowedActions,
        nodeId: g.nodeId,
        node: g.node,
        project: g.project,
        clientAccount: g.clientAccount,
        grantId: existing?.grantId ?? g.id,
        aliasIds: existing ? [...existing.aliasIds, g.id] : [g.id]
      });
    }
  }

  return result;
}

export async function listContainersForSession(session: AuthSession): Promise<ContainerView[]> {
  const visible = await resolveVisibleContainersForSession(session);
  const byNode = new Map<string, GrantContainerRow[]>();
  for (const row of visible.values()) {
    const list = byNode.get(row.nodeId) ?? [];
    list.push(row);
    byNode.set(row.nodeId, list);
  }

  const results: ContainerView[] = [];

  for (const [nodeId, rows] of byNode) {
    const node = await prisma.node.findUnique({ where: { id: nodeId } });
    if (!node) continue;
    const runtimePayload = await nodeAgentClient.listContainers(node);
    await recordNodePoll(node, runtimePayload.nodeOnline);
    const runtimeMap = new Map(runtimePayload.containers.map((entry) => [entry.id, entry]));

    for (const row of rows) {
      const live = runtimeMap.get(row.dockerContainerId);
      const mapped = live ? { ...live, status: mapStatus(live.status) } : null;
      results.push(toContainerView(grantToAssignment(row), mapped, runtimePayload.nodeOnline));
    }
  }

  return results;
}

export async function getContainerByGrant(
  session: AuthSession,
  grantId: string
): Promise<{ container: ContainerView | null; grant: GrantContainerRow | null }> {
  const visible = await resolveVisibleContainersForSession(session);
  const row = Array.from(visible.values()).find((r) => rowMatchesGrant(r, grantId));
  if (!row) {
    return { container: null, grant: null };
  }

  const node = await prisma.node.findUnique({ where: { id: row.nodeId } });
  if (!node) {
    return { container: null, grant: row };
  }

  const runtimePayload = await nodeAgentClient.getContainer(node, row.dockerContainerId);
  const live = runtimePayload.container ?? null;
  const mapped = live ? { ...live, status: mapStatus(live.status) } : null;

  const container = toContainerView(grantToAssignment(row), mapped, runtimePayload.nodeOnline);

  return { container, grant: row };
}

/**
 * Check that the session may view logs on the container referenced by
 * grantId, and return the resolved node + docker id. DB-only (no agent call),
 * so it is cheap to run before opening a long-lived log stream.
 */
export async function resolveLogTarget(
  session: AuthSession,
  grantId: string
): Promise<{ node: Node; dockerContainerId: string } | null> {
  const visible = await resolveVisibleContainersForSession(session);
  const row = Array.from(visible.values()).find((r) => rowMatchesGrant(r, grantId));
  if (!row) {
    return null;
  }
  if (session.role !== Role.ADMIN && !row.allowedActions.includes("view_logs")) {
    return null;
  }
  const node = await prisma.node.findUnique({ where: { id: row.nodeId } });
  if (!node) {
    return null;
  }
  return { node, dockerContainerId: row.dockerContainerId };
}

export async function getContainerLogs(
  session: AuthSession,
  grantId: string,
  tail = 200
): Promise<{ logs: string[]; nodeOnline: boolean; allowed: boolean } | null> {
  const { grant } = await getContainerByGrant(session, grantId);
  if (!grant) {
    return null;
  }
  if (!grant.allowedActions.includes("view_logs") && session.role !== Role.ADMIN) {
    return { logs: [], nodeOnline: false, allowed: false };
  }
  const node = await prisma.node.findUnique({ where: { id: grant.nodeId } });
  if (!node) {
    return null;
  }
  const logResponse = await nodeAgentClient.getLogs(node, grant.dockerContainerId, tail);
  return { logs: logResponse.logs, nodeOnline: logResponse.nodeOnline, allowed: true };
}

/**
 * Check that the session may perform `action` on the container referenced by
 * grantId, and return the resolved node + docker id if allowed.
 *
 * TWO independent gates, both server-side:
 *  1. ROLE capability — `container.start|stop|restart`. CLIENT_VIEWER has none
 *     of these, so a viewer is refused even for a container whose grant
 *     permits the action. (Defense in depth: routes also gate, but this is the
 *     authoritative check every caller passes through.)
 *  2. GRANT scope — the specific grant must allow the action.
 */
export async function resolveActionTarget(
  session: AuthSession,
  grantId: string,
  action: "start" | "stop" | "restart"
): Promise<{ nodeId: string; dockerContainerId: string; allowedActions: string[] } | null> {
  if (!can(session, `container.${action}` as Capability)) {
    return null;
  }
  const { grant } = await getContainerByGrant(session, grantId);
  if (!grant) {
    return null;
  }
  if (session.role === Role.ADMIN) {
    return { nodeId: grant.nodeId, dockerContainerId: grant.dockerContainerId, allowedActions: grant.allowedActions };
  }
  if (!grant.allowedActions.includes(action)) {
    return null;
  }
  return { nodeId: grant.nodeId, dockerContainerId: grant.dockerContainerId, allowedActions: grant.allowedActions };
}

/** ADMIN-only direct container access by node + docker id (no grant needed). */
export async function getContainerDirect(
  nodeId: string,
  dockerContainerId: string
): Promise<{ container: ContainerView | null; nodeOnline: boolean }> {
  const node = await prisma.node.findUnique({ where: { id: nodeId } });
  if (!node) {
    return { container: null, nodeOnline: false };
  }
  const payload = await nodeAgentClient.getContainer(node, dockerContainerId);
  if (!payload.container) {
    return { container: null, nodeOnline: payload.nodeOnline };
  }
  const live = { ...payload.container, status: mapStatus(payload.container.status) };
  const assignment = await prisma.containerAssignment.findFirst({
    where: { nodeId, dockerContainerId, isActive: true },
    include: {
      node: { select: { id: true, name: true } },
      project: { select: { id: true, name: true } },
      clientAccount: { select: { id: true, name: true } }
    }
  });
  if (assignment) {
    return { container: toContainerView(assignment, live, payload.nodeOnline), nodeOnline: payload.nodeOnline };
  }
  const containerRow = await prisma.container.findUnique({
    where: { nodeId_dockerContainerId: { nodeId, dockerContainerId } },
    include: { project: { select: { id: true, name: true } } }
  });
  return {
    container: {
      assignmentId: "",
      containerId: live.id,
      name: live.name,
      image: live.image,
      status: live.status,
      health: live.health ?? null,
      uptime: live.uptime,
      ports: live.ports,
      createdAt: live.createdAt,
      cpuPercent: live.cpuPercent,
      memoryUsage: live.memoryUsage,
      restartCount: live.restartCount,
      restartPolicy: live.restartPolicy ?? null,
      nodeId,
      nodeName: node.name,
      nodeOnline: payload.nodeOnline,
      projectName: containerRow?.project?.name ?? null,
      projectId: containerRow?.project?.id ?? null,
      clientName: "Unassigned",
      allowedActions: [],
      lastUpdatedAt: live.lastUpdatedAt,
      details: live.details ?? null
    },
    nodeOnline: payload.nodeOnline
  };
}

export async function getContainerLogsDirect(
  nodeId: string,
  dockerContainerId: string,
  tail = 200
): Promise<{ logs: string[]; nodeOnline: boolean }> {
  const node = await prisma.node.findUnique({ where: { id: nodeId } });
  if (!node) {
    return { logs: [], nodeOnline: false };
  }
  return nodeAgentClient.getLogs(node, dockerContainerId, tail);
}

export async function listDiscoveredContainersForAdmin(): Promise<DiscoveredContainer[]> {
  const nodes = await prisma.node.findMany({ where: { isActive: true } });
  const out: DiscoveredContainer[] = [];
  for (const node of nodes) {
    const payload = await nodeAgentClient.listContainers(node);
    for (const c of payload.containers) {
      out.push({
        dockerContainerId: c.id,
        dockerName: c.name,
        image: c.image,
        status: c.status,
        nodeId: node.id,
        nodeName: node.name
      });
    }
  }
  return out;
}

export function buildOverview(containers: ContainerView[]): OverviewStats {
  const running = containers.filter((item) => item.status === "running").length;
  const stopped = containers.filter((item) => item.status === "stopped").length;
  const restarting = containers.filter((item) => item.status === "restarting").length;
  const unhealthy = containers.filter((item) => item.health === "unhealthy" || item.status === "unhealthy").length;
  const nodeKeys = new Map<string, boolean>();

  for (const container of containers) {
    nodeKeys.set(container.nodeId, container.nodeOnline);
  }

  const offlineNodes = Array.from(nodeKeys.values()).filter((isOnline) => !isOnline).length;
  const onlineNodes = Array.from(nodeKeys.values()).filter((isOnline) => isOnline).length;

  return {
    totalContainers: containers.length,
    runningContainers: running,
    stoppedContainers: stopped,
    restartingContainers: restarting,
    unhealthyContainers: unhealthy,
    offlineNodes,
    onlineNodes
  };
}

/**
 * ADMIN-only: gather every container on every active node with assignment
 * metadata (client/project). Unassigned containers are read-only.
 */
async function collectAllContainersEnriched(): Promise<ContainerView[]> {
  const snapshot = await collectOverviewSnapshot();
  const nodeIds = snapshot.nodes.filter((node) => node.isActive).map((node) => node.id);
  const nodes = await prisma.node.findMany({ where: { id: { in: nodeIds } }, orderBy: { name: "asc" } });

  const assignments = await prisma.containerAssignment.findMany({
    where: { isActive: true },
    include: {
      node: { select: { id: true, name: true } },
      project: { select: { id: true, name: true } },
      clientAccount: { select: { id: true, name: true } }
    }
  });
  const assignmentByNodeContainer = new Map<string, AssignmentWithRelations>();
  for (const assignment of assignments) {
    assignmentByNodeContainer.set(`${assignment.nodeId}:${assignment.dockerContainerId}`, assignment);
  }

  const results: ContainerView[] = [];
  for (const node of nodes) {
    const operational = snapshot.nodes.find((item) => item.id === node.id);
    const runtimePayload = {
      nodeOnline: operational?.polledOnline === true,
      containers: snapshot.containersByNode.get(node.id) ?? []
    };

    const seenIds = new Set<string>();
    for (const live of runtimePayload.containers) {
      seenIds.add(live.id);
      const assignment = assignmentByNodeContainer.get(`${node.id}:${live.id}`);
      const mapped = { ...live, status: mapStatus(live.status) };

      if (assignment) {
        results.push(toContainerView(assignment, mapped, runtimePayload.nodeOnline));
      } else {
        results.push({
          assignmentId: "",
          containerId: live.id,
          name: live.name,
          image: live.image,
          status: mapped.status,
          health: live.health ?? null,
          uptime: live.uptime,
          ports: live.ports,
          createdAt: live.createdAt,
          cpuPercent: live.cpuPercent,
          memoryUsage: live.memoryUsage,
          restartCount: live.restartCount,
          restartPolicy: live.restartPolicy ?? null,
          nodeId: node.id,
          nodeName: node.name,
          nodeOnline: runtimePayload.nodeOnline,
          projectName: null,
          projectId: null,
          clientName: "Unassigned",
          clientId: null,
          allowedActions: [],
          lastUpdatedAt: live.lastUpdatedAt,
          details: live.details ?? null
        });
      }
    }

    // Data consistency: containers no longer reported by the agent are marked
    // inactive (kept for history, never deleted). Guard: only sweep when the
    // agent actually answered with an inventory (an offline/timed-out agent
    // returns an empty list and must never trigger a sweep).
    if (runtimePayload.nodeOnline && seenIds.size > 0) {
      const deactivating = await prisma.container
        .findMany({
          where: { nodeId: node.id, isActive: true, dockerContainerId: { notIn: Array.from(seenIds) } },
          select: { id: true }
        })
        .catch(() => []);
      if (deactivating.length > 0) {
        const deactivatingIds = deactivating.map((c) => c.id);
        await prisma.container
          .updateMany({
            where: { id: { in: deactivatingIds } },
            data: { isActive: false, lastSeenAt: new Date() }
          })
          .catch(() => undefined);
        await reconcileIngressEndpointsForDeactivatedContainers(deactivatingIds);
      }
    }

    // Compose reconciliation already ran in collectOverviewSnapshot().
  }

  // Polling can open or resolve attention conditions. Attach the freshly
  // persisted severity only after all node snapshots have been observed.
  await syncAttentionIfDue(snapshot);
  const attentionMap = await getAttentionMap();
  for (const item of results) {
    item.attention = attentionMap.get(`CONTAINER:${item.nodeId}:${item.containerId}`)
      ?? (item.status === "running" && item.health !== "unhealthy" ? "healthy" : "unknown");
  }

  // Operator-declared intent (expectedState) lets the UI render "stopped
  // intentionally" quietly instead of as an unexpected stop (design status
  // vocabulary). Backend-authoritative: the frontend never guesses intent.
  const expectedStates = await getExpectedStates(nodeIds);
  for (const item of results) {
    const expected = expectedStates.get(`${item.nodeId}:${item.containerId}`);
    item.expectedStopped = isExpectedRunning(item.restartPolicy, expected) === false;
  }

  return results.sort(
    (a, b) => a.nodeName.localeCompare(b.nodeName) || a.name.localeCompare(b.name)
  );
}

export async function listAllContainersForAdmin(): Promise<ContainerView[]> {
  return collectAllContainersEnriched();
}

/**
 * Server-side query for the admin all-containers list. Live status is gathered
 * once per node (bounded by the number of active nodes/containers), then
 * filtered, sorted and paginated so the browser only ever receives a single
 * page. Validates sort keys against a whitelist to avoid arbitrary comparators.
 */
export type ContainersQuery = {
  search?: string;
  status?: string;
  nodeId?: string;
  clientId?: string;
  projectId?: string;
  health?: string;
  /** When true, only containers with an active attention condition (warning/critical). */
  needsAttention?: boolean;
  sort?: string;
  dir?: "asc" | "desc";
  page?: number;
  limit?: number;
};

const ATTENTION_RANK: Record<string, number> = { critical: 0, warning: 1, info: 2, unknown: 3, healthy: 4 };

export async function queryAllContainersForAdmin(
  opts: ContainersQuery
): Promise<{ containers: ContainerView[]; total: number; page: number; limit: number; pageCount: number }> {
  const all = await collectAllContainersEnriched();

  const search = opts.search?.trim().toLowerCase();
  const status = opts.status?.trim().toLowerCase();
  const nodeId = opts.nodeId?.trim();
  const clientId = opts.clientId?.trim();
  const projectId = opts.projectId?.trim();
  const health = opts.health?.trim().toLowerCase();

  let rows = all;

  if (search) {
    rows = rows.filter((c) =>
      [c.name, c.image, c.containerId, c.nodeName, c.clientName, c.projectName ?? ""]
        .some((f) => f && f.toLowerCase().includes(search))
    );
  }
  if (status) {
    rows = rows.filter((c) => c.status === status);
  }
  if (nodeId) {
    rows = rows.filter((c) => c.nodeId === nodeId);
  }
  if (clientId) {
    rows = rows.filter((c) => c.clientId === clientId);
  }
  if (projectId) {
    rows = rows.filter((c) => c.projectId === projectId);
  }
  if (health) {
    rows = rows.filter((c) => (c.health ?? "none") === health);
  }
  if (opts.needsAttention) {
    rows = rows.filter((c) => c.attention === "critical" || c.attention === "warning");
  }

  const dir = opts.dir === "desc" ? -1 : 1;
  switch (opts.sort) {
    case "node":
      rows = [...rows].sort((a, b) => dir * a.nodeName.localeCompare(b.nodeName));
      break;
    case "client":
      rows = [...rows].sort((a, b) => dir * a.clientName.localeCompare(b.clientName));
      break;
    case "status":
      rows = [...rows].sort((a, b) => dir * a.status.localeCompare(b.status));
      break;
    case "health":
      rows = [...rows].sort((a, b) => dir * (a.health ?? "none").localeCompare(b.health ?? "none"));
      break;
    case "cpu":
      rows = [...rows].sort((a, b) => dir * ((a.cpuPercent ?? -1) - (b.cpuPercent ?? -1)));
      break;
    case "restartCount":
      rows = [...rows].sort((a, b) => dir * ((a.restartCount ?? 0) - (b.restartCount ?? 0)));
      break;
    case "name":
      rows = [...rows].sort((a, b) => dir * a.name.localeCompare(b.name));
      break;
    case "attention":
    default:
      // Default view (§7): problematic containers first (explicit severity
      // rank, not a continuously-changing metric like CPU%), then healthy
      // ones, each group alphabetical by name for a stable secondary order.
      // Never reorders purely because CPU% ticked — attention severity only
      // changes on a real state transition (see attention.ts sync pass).
      rows = [...rows].sort((a, b) => {
        const rankDiff = (ATTENTION_RANK[a.attention ?? "unknown"] ?? 3) - (ATTENTION_RANK[b.attention ?? "unknown"] ?? 3);
        if (rankDiff !== 0) return dir === -1 ? -rankDiff : rankDiff;
        return a.name.localeCompare(b.name);
      });
  }

  const total = rows.length;
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const page = Math.max(opts.page ?? 1, 1);
  const pageCount = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(page, pageCount);
  const start = (safePage - 1) * limit;
  const containers = rows.slice(start, start + limit);

  return { containers, total, page: safePage, limit, pageCount };
}
