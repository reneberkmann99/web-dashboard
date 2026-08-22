import { ProjectSource } from "@prisma/client";
import { lockContainersForUpdate, prisma } from "@/server/db";
import { nodeAgentClient } from "@/server/services/node-agent/client";
import { reconcileIngressEndpointsForDeactivatedContainers } from "@/server/services/ingress";

/**
 * Compose workload discovery, adoption, conversion & reconciliation.
 *
 * A Docker Compose project (identified by the `com.docker.compose.project`
 * label) can become a Noderaft workload. Two sources coexist:
 *   - MANUAL    — intentionally curated workloads (e.g. "Home Lab").
 *   - COMPOSE   — discovered from Docker Compose labels; membership is kept in
 *                 sync automatically as containers are recreated/add/removed.
 *
 * Safety:
 *   - Reconciliation only touches COMPOSE projects. MANUAL workloads are never
 *     modified by this module.
 *   - Container identity stays (node, dockerContainerId); a recreated container
 *     gets a new Docker id and is re-associated by its Compose labels, while the
 *     stale row is marked inactive (never deleted).
 *   - Grants are project-level, so ordinary Compose container recreation does
 *     not disturb tenant access.
 *   - Adoption/conversion NEVER silently steals containers from another
 *     workload — conflicts are detected up front and require an explicit,
 *     confirmed resolution (`moveConflictingContainers: true`).
 *   - Detach and every read path here are pure DB operations; nothing in this
 *     module ever issues a mutating Docker command (no start/stop/rm, no
 *     `docker compose down`).
 */

export type ComposeContainerRef = {
  id: string;
  name: string;
  image: string | null;
  composeProject?: string | null;
  composeService?: string | null;
};

// Reconciliation does DB upserts per container; throttle it so frequent
// dashboard polling (every 8-20s) doesn't force a full reconcile pass on
// every request. A stale-by-at-most-N-seconds view is an acceptable
// trade-off for interactive dashboards; the admin containers page still
// triggers a reconcile on its own cadence.
const RECONCILE_THROTTLE_MS = 30_000;
const lastReconcileAt = new Map<string, number>();

function shouldReconcile(nodeId: string): boolean {
  const now = Date.now();
  const last = lastReconcileAt.get(nodeId) ?? 0;
  if (now - last < RECONCILE_THROTTLE_MS) {
    return false;
  }
  lastReconcileAt.set(nodeId, now);
  return true;
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "compose"
  );
}

/**
 * Ensure a slug is unique per node (the (nodeId, slug) unique constraint).
 * A stale MANUAL remnant of a previously adopted/detached project can still
 * hold the slug on the same node — appending -2/-3 … keeps adoption working
 * instead of failing on the constraint.
 */
async function uniqueSlugForNode(nodeId: string, base: string): Promise<string> {
  const baseSlug = slugify(base);
  const existing = await prisma.project.findMany({
    where: { nodeId, slug: { startsWith: baseSlug } },
    select: { slug: true }
  });
  const used = new Set(existing.map((p) => p.slug));
  if (!used.has(baseSlug)) return baseSlug;
  let i = 2;
  for (;;) {
    const candidate = `${baseSlug.slice(0, 56)}-${i}`;
    if (!used.has(candidate)) return candidate;
    i += 1;
  }
}

/**
 * Reconcile COMPOSE workloads on a node against the live container inventory.
 * For each existing COMPOSE project on the node, associate current members and
 * mark no-longer-reported members inactive. Returns the number of projects
 * reconciled.
 */
export async function reconcileComposeWorkloads(nodeId: string, live: ComposeContainerRef[]): Promise<number> {
  const composeGroups = new Map<string, ComposeContainerRef[]>();
  for (const c of live) {
    if (!c.composeProject) continue;
    const group = composeGroups.get(c.composeProject) ?? [];
    group.push(c);
    composeGroups.set(c.composeProject, group);
  }

  const projects = await prisma.project.findMany({
    where: { nodeId, source: ProjectSource.COMPOSE, isActive: true }
  });

  let reconciled = 0;
  for (const project of projects) {
    if (!project.composeProject) continue;
    const members = composeGroups.get(project.composeProject) ?? [];
    reconciled += 1;

    // Upsert every current member and (re)associate it to this project.
    for (const c of members) {
      await prisma.container.upsert({
        where: { nodeId_dockerContainerId: { nodeId, dockerContainerId: c.id } },
        update: {
          dockerName: c.name,
          image: c.image ?? undefined,
          composeProject: c.composeProject ?? null,
          composeService: c.composeService ?? null,
          projectId: project.id,
          isActive: true,
          lastSeenAt: new Date()
        },
        create: {
          nodeId,
          dockerContainerId: c.id,
          dockerName: c.name,
          image: c.image ?? null,
          composeProject: c.composeProject ?? null,
          composeService: c.composeService ?? null,
          projectId: project.id,
          isActive: true,
          lastSeenAt: new Date()
        }
      });
    }

    // Containers previously in this project but no longer reported become
    // inactive (kept for history, never deleted).
    if (members.length > 0) {
      const deactivating = await prisma.container.findMany({
        where: {
          projectId: project.id,
          nodeId,
          isActive: true,
          dockerContainerId: { notIn: members.map((c) => c.id) }
        },
        select: { id: true }
      });
      if (deactivating.length > 0) {
        const deactivatingIds = deactivating.map((c) => c.id);
        await prisma.container.updateMany({
          where: { id: { in: deactivatingIds } },
          data: { isActive: false, lastSeenAt: new Date() }
        });
        await reconcileIngressEndpointsForDeactivatedContainers(deactivatingIds);
      }
    }
  }

  return reconciled;
}

/**
 * Throttled combined pass: record Compose labels + reconcile COMPOSE workload
 * membership for a node's live inventory. Safe to call on every inventory
 * refresh — internally skipped when the node was reconciled within the last
 * RECONCILE_THROTTLE_MS.
 */
export async function reconcileComposeIfDue(nodeId: string, live: ComposeContainerRef[]): Promise<void> {
  if (!shouldReconcile(nodeId)) {
    return;
  }
  await recordComposeMetadata(nodeId, live);
  await reconcileComposeWorkloads(nodeId, live);
}

/**
 * Store Compose labels on the discovered Container rows even before a workload
 * is adopted, so an admin can see and adopt the project later.
 */
export async function recordComposeMetadata(nodeId: string, live: ComposeContainerRef[]): Promise<void> {
  for (const c of live) {
    if (!c.composeProject && !c.composeService) continue;
    await prisma.container
      .upsert({
        where: { nodeId_dockerContainerId: { nodeId, dockerContainerId: c.id } },
        update: {
          dockerName: c.name,
          image: c.image ?? undefined,
          composeProject: c.composeProject ?? null,
          composeService: c.composeService ?? null,
          lastSeenAt: new Date(),
          isActive: true
        },
        create: {
          nodeId,
          dockerContainerId: c.id,
          dockerName: c.name,
          image: c.image ?? null,
          composeProject: c.composeProject ?? null,
          composeService: c.composeService ?? null,
          lastSeenAt: new Date(),
          isActive: true
        }
      })
      .catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Discovery (list + detail)
// ---------------------------------------------------------------------------

export type DiscoveredComposeProject = {
  nodeId: string;
  nodeName: string;
  composeProject: string;
  containerCount: number;
  runningCount: number;
  healthSummary: "healthy" | "degraded" | "down" | "unknown";
  serviceNames: string[];
  networkCount: number;
  volumeCount: number;
  /** True if any of this project's containers already belong to a different Noderaft workload. */
  hasConflict: boolean;
  lastObservedAt: string | null;
  adopted: boolean;
  workloadId: string | null;
  workloadName: string | null;
};

/**
 * List Compose projects detected across nodes, enriched with health/service/
 * conflict summaries. Groups agent calls by node — exactly one
 * `listContainers()` per node regardless of how many Compose projects that
 * node has (the agent's own 15s in-memory cache makes this effectively free
 * when called shortly after a dashboard poll).
 */
export async function listDiscoveredComposeProjects(): Promise<DiscoveredComposeProject[]> {
  // Discovery is LIVE-DRIVEN, not DB-driven: poll the agent inventory on every
  // active node and group by the live `com.docker.compose.project` label.
  // (The previous DB-driven approach only surfaced projects already synced by a
  // throttled overview reconcile, so a freshly-created stack was invisible.)
  const nodes = await prisma.node.findMany({ where: { isActive: true } });

  const liveByNode = new Map<string, Awaited<ReturnType<typeof nodeAgentClient.listContainers>>>();
  await Promise.all(
    nodes.map(async (node) => {
      try {
        liveByNode.set(node.id, await nodeAgentClient.listContainers(node));
      } catch {
        liveByNode.set(node.id, { nodeOnline: false, containers: [] });
      }
    })
  );

  // Conflict + adoption metadata: which live containers already belong to a
  // different Noderaft workload, and which compose projects are already
  // adopted as a COMPOSE workload. Live `c.id` is the docker container ID,
  // which maps to Container.dockerContainerId (scoped per node).
  const liveContainerIds = new Set<string>();
  for (const payload of liveByNode.values()) {
    for (const c of payload.containers) liveContainerIds.add(c.id);
  }
  const dbRows = liveContainerIds.size === 0
    ? []
    : await prisma.container.findMany({
        where: {
          isActive: true,
          OR: Array.from(liveContainerIds).map((id) => ({ dockerContainerId: id }))
        },
        select: {
          dockerContainerId: true,
          nodeId: true,
          projectId: true,
          project: { select: { id: true, name: true, source: true, composeProject: true } }
        }
      });
  const dbByKey = new Map(dbRows.map((r) => [`${r.nodeId}:${r.dockerContainerId}`, r]));

  const adoptedProjects = await prisma.project.findMany({
    where: { source: ProjectSource.COMPOSE, isActive: true },
    select: { id: true, name: true, nodeId: true, composeProject: true }
  });
  const adoptedByKey = new Map(adoptedProjects.map((p) => [`${p.nodeId}:${p.composeProject}`, p]));

  const groups = new Map<
    string,
    {
      nodeId: string;
      nodeName: string;
      composeProject: string;
      running: number;
      unhealthy: number;
      total: number;
      services: Set<string>;
      networkNames: Set<string>;
      volumeNames: Set<string>;
      hasConflict: boolean;
    }
  >();

  for (const node of nodes) {
    const payload = liveByNode.get(node.id);
    if (!payload?.nodeOnline) continue;
    for (const c of payload.containers) {
      if (!c.composeProject) continue;
      const key = `${node.id}:${c.composeProject}`;
      const entry = groups.get(key) ?? {
        nodeId: node.id,
        nodeName: node.name,
        composeProject: c.composeProject,
        running: 0,
        unhealthy: 0,
        total: 0,
        services: new Set<string>(),
        networkNames: new Set<string>(),
        volumeNames: new Set<string>(),
        hasConflict: false
      };
      entry.total += 1;
      if (c.status === "running") entry.running += 1;
      if (c.health === "unhealthy" || c.status === "unhealthy") entry.unhealthy += 1;
      if (c.composeService) entry.services.add(c.composeService);
      for (const n of c.networkNames ?? []) entry.networkNames.add(n);
      for (const m of c.mountRefs ?? []) {
        if (m.type === "volume" && m.volumeName) entry.volumeNames.add(m.volumeName);
      }
      const db = dbByKey.get(`${node.id}:${c.id}`);
      if (db?.projectId && !(db.project?.source === ProjectSource.COMPOSE && db.project.composeProject === c.composeProject)) {
        entry.hasConflict = true;
      }
      groups.set(key, entry);
    }
  }

  const results: DiscoveredComposeProject[] = [];
  for (const [key, g] of groups) {
    const adopted = adoptedByKey.get(key);
    results.push({
      nodeId: g.nodeId,
      nodeName: g.nodeName,
      composeProject: g.composeProject,
      containerCount: g.total,
      runningCount: g.running,
      healthSummary: g.unhealthy > 0 ? "degraded" : g.running === g.total ? "healthy" : g.running === 0 ? "down" : "degraded",
      serviceNames: Array.from(g.services).sort(),
      networkCount: g.networkNames.size,
      volumeCount: g.volumeNames.size,
      hasConflict: g.hasConflict,
      lastObservedAt: null,
      adopted: Boolean(adopted),
      workloadId: adopted?.id ?? null,
      workloadName: adopted?.name ?? null
    });
  }

  return results.sort((a, b) => a.nodeName.localeCompare(b.nodeName) || a.composeProject.localeCompare(b.composeProject));
}

export type ComposeConflict = {
  workloadId: string;
  workloadName: string;
  workloadSource: string;
  containerNames: string[];
};

/**
 * Detect containers (by internal Container.id) that are already members of a
 * DIFFERENT workload than the one implied by `composeProject`. Used both by
 * adoption (before creating a new COMPOSE workload) and by the discovery
 * detail screen (to surface the warning before the admin even opens the
 * wizard).
 */
async function detectComposeConflicts(
  composeProject: string,
  containerIds: string[]
): Promise<ComposeConflict[]> {
  if (containerIds.length === 0) return [];
  const rows = await prisma.container.findMany({
    where: { id: { in: containerIds }, projectId: { not: null } },
    select: {
      dockerName: true,
      project: { select: { id: true, name: true, source: true, composeProject: true } }
    }
  });

  const byProject = new Map<string, ComposeConflict>();
  for (const r of rows) {
    if (!r.project) continue;
    if (r.project.source === ProjectSource.COMPOSE && r.project.composeProject === composeProject) {
      continue; // already the target Compose workload — not a conflict
    }
    const existing = byProject.get(r.project.id);
    if (existing) {
      existing.containerNames.push(r.dockerName);
    } else {
      byProject.set(r.project.id, {
        workloadId: r.project.id,
        workloadName: r.project.name,
        workloadSource: r.project.source,
        containerNames: [r.dockerName]
      });
    }
  }
  return Array.from(byProject.values());
}

export type DiscoveredComposeProjectDetail = {
  nodeId: string;
  nodeName: string;
  composeProject: string;
  services: Array<{
    dockerContainerId: string;
    dockerName: string;
    composeService: string | null;
    status: string;
    image: string;
  }>;
  runningCount: number;
  totalCount: number;
  healthSummary: "healthy" | "degraded" | "down" | "unknown";
  networks: string[];
  volumes: string[];
  lastObservedAt: string | null;
  conflicts: ComposeConflict[];
  adopted: boolean;
  workloadId: string | null;
  workloadName: string | null;
};

/** Full detail for a single discovered (or already-adopted) Compose project. */
export async function getDiscoveredComposeProjectDetail(
  nodeId: string,
  composeProject: string
): Promise<DiscoveredComposeProjectDetail | null> {
  const node = await prisma.node.findUnique({ where: { id: nodeId } });
  if (!node) return null;

  // Live-driven like listDiscoveredComposeProjects: derive services from the
  // agent inventory directly, not from DB rows that may not be synced yet.
  const live = await nodeAgentClient.listContainers(node);
  const liveServices = live.containers.filter((c) => c.composeProject === composeProject);
  if (liveServices.length === 0) return null;

  // Conflict + adoption metadata: map docker IDs to already-managed DB rows.
  const dbRows = await prisma.container.findMany({
    where: {
      nodeId,
      isActive: true,
      OR: liveServices.map((c) => ({ dockerContainerId: c.id }))
    },
    select: { id: true, dockerContainerId: true, projectId: true }
  });
  const dbIdByDocker = new Map(dbRows.map((r) => [r.dockerContainerId, r.id]));

  const services = liveServices.map((lc) => ({
    dockerContainerId: lc.id,
    dockerName: lc.name,
    composeService: lc.composeService ?? null,
    status: lc.status,
    health: lc.health ?? null,
    image: lc.image ?? "unknown"
  }));

  const total = services.length;
  const running = services.filter((s) => s.status === "running").length;
  const unhealthy = services.filter((s) => s.health === "unhealthy" || s.status === "unhealthy").length;
  const healthSummary: DiscoveredComposeProjectDetail["healthSummary"] = !live.nodeOnline
    ? "unknown"
    : unhealthy > 0
      ? "degraded"
      : running === total
        ? "healthy"
        : running === 0
          ? "down"
          : "degraded";

  const networkNames = new Set<string>();
  const volumeNames = new Set<string>();
  for (const lc of liveServices) {
    for (const n of lc.networkNames ?? []) networkNames.add(n);
    for (const m of lc.mountRefs ?? []) {
      if (m.type === "volume" && m.volumeName) volumeNames.add(m.volumeName);
    }
  }

  const conflicts = await detectComposeConflicts(
    composeProject,
    dbRows.map((r) => r.id)
  );

  const adopted = await prisma.project.findFirst({
    where: { nodeId, composeProject, source: ProjectSource.COMPOSE },
    select: { id: true, name: true }
  });

  return {
    nodeId,
    nodeName: node.name,
    composeProject,
    services: services.sort((a, b) => a.dockerName.localeCompare(b.dockerName)),
    runningCount: running,
    totalCount: total,
    healthSummary,
    networks: Array.from(networkNames).sort(),
    volumes: Array.from(volumeNames).sort(),
    lastObservedAt: null,
    conflicts,
    adopted: Boolean(adopted),
    workloadId: adopted?.id ?? null,
    workloadName: adopted?.name ?? null
  };
}

// ---------------------------------------------------------------------------
// Adoption
// ---------------------------------------------------------------------------

export type AdoptComposeResult =
  | { status: "adopted"; id: string }
  | { status: "already_adopted"; workloadId: string; workloadName: string }
  | { status: "conflict"; conflicts: ComposeConflict[] }
  | { status: "not_found" }
  | { status: "container_has_ingress_endpoint" };

/**
 * Adopt a detected Compose project as a COMPOSE workload, optionally owned by
 * a client (nullable — "internal, no client" is a valid choice per the
 * adoption wizard). Never silently reassigns containers that already belong
 * to another workload: if conflicts exist, the caller must explicitly pass
 * `moveConflictingContainers: true` to proceed.
 */
export async function adoptComposeProject(input: {
  clientAccountId?: string | null;
  nodeId: string;
  composeProject: string;
  name?: string;
  slug?: string;
  description?: string | null;
  moveConflictingContainers?: boolean;
}): Promise<AdoptComposeResult> {
  // Record live compose metadata first so a freshly-created stack (not yet
  // synced by the throttled overview reconcile) is adoptable immediately.
  const node = await prisma.node.findUnique({ where: { id: input.nodeId } });
  if (node) {
    try {
      const live = await nodeAgentClient.listContainers(node);
      if (live.nodeOnline) {
        await recordComposeMetadata(
          input.nodeId,
          live.containers
            .filter((c) => c.composeProject === input.composeProject)
            .map((c) => ({ id: c.id, name: c.name, image: c.image, composeProject: c.composeProject ?? null, composeService: c.composeService ?? null }))
        );
      }
    } catch {
      // fall through to DB-backed membership below
    }
  }

  const members = await prisma.container.findMany({
    where: { nodeId: input.nodeId, composeProject: input.composeProject, isActive: true },
    select: { id: true }
  });
  if (members.length === 0) {
    return { status: "not_found" };
  }

  const existing = await prisma.project.findFirst({
    where: { nodeId: input.nodeId, composeProject: input.composeProject, source: ProjectSource.COMPOSE },
    select: { id: true, name: true }
  });
  if (existing) {
    return { status: "already_adopted", workloadId: existing.id, workloadName: existing.name };
  }

  const conflicts = await detectComposeConflicts(
    input.composeProject,
    members.map((m) => m.id)
  );
  if (conflicts.length > 0 && !input.moveConflictingContainers) {
    return { status: "conflict", conflicts };
  }

  const friendly = input.name?.trim() || input.composeProject;
  const slug = input.slug?.trim()
    ? await uniqueSlugForNode(input.nodeId, input.slug.trim())
    : await uniqueSlugForNode(input.nodeId, friendly);
  const memberIds = members.map((m) => m.id);

  // Reparenting a container to a new (possibly differently-owned) workload
  // below never updates or checks IngressEndpoint.containerId — a bound
  // endpoint would keep its OLD workload/organization ownership while its
  // actual backend container silently belongs to the new one, letting the
  // old tenant keep controlling public routing into infrastructure that's
  // no longer semantically theirs. Refuse instead, same as
  // deleteContainer's guard (server/services/container-lifecycle.ts). The
  // whole check-then-reparent runs under a lock on every member container
  // (see server/db.ts's lockContainersForUpdate doc comment) — a plain
  // pre-transaction check here could otherwise leave a window where a
  // concurrent createIngressEndpoint/updateIngressEndpoint attaches one of
  // these containers after this check but before the reparenting update,
  // recreating the exact cross-tenant routing condition this guard exists
  // to prevent.
  const created = await prisma.$transaction(async (tx) => {
    await lockContainersForUpdate(tx, memberIds);

    const boundEndpoint = await tx.ingressEndpoint.findFirst({
      where: { containerId: { in: memberIds } },
      select: { id: true }
    });
    if (boundEndpoint) return null;

    const project = await tx.project.create({
      data: {
        name: friendly,
        slug,
        description: input.description ?? null,
        source: ProjectSource.COMPOSE,
        composeProject: input.composeProject,
        clientAccountId: input.clientAccountId,
        nodeId: input.nodeId,
        isActive: true
      }
    });

    await tx.container.updateMany({
      where: { id: { in: memberIds } },
      data: { projectId: project.id, isActive: true }
    });

    return project;
  });

  if (!created) {
    return { status: "container_has_ingress_endpoint" };
  }

  return { status: "adopted", id: created.id };
}

// ---------------------------------------------------------------------------
// Manual → Compose conversion
// ---------------------------------------------------------------------------

export type ConvertConflictReason =
  | "already_compose"
  | "no_compose_label"
  | "multiple_compose_projects"
  | "compose_project_already_adopted_elsewhere"
  | "partial_membership";

export type ConvertPreview =
  | {
      eligible: true;
      composeProject: string;
      workloadContainers: string[];
      allComposeServices: string[];
    }
  | { eligible: false; reason: ConvertConflictReason; detail: string };

/**
 * Determine whether a MANUAL workload can be safely converted to a
 * COMPOSE-managed workload: every active member must carry the SAME
 * `com.docker.compose.project` label, no non-Compose containers may be
 * mixed in, the Compose project name must not already be adopted by a
 * different workload, and the manual workload's membership must already be
 * the FULL set of live containers for that Compose project (converting must
 * never silently drop services out of tracking).
 */
export async function previewConvertToCompose(projectId: string): Promise<ConvertPreview | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { containers: { where: { isActive: true } } }
  });
  if (!project) return null;

  if (project.source === ProjectSource.COMPOSE) {
    return { eligible: false, reason: "already_compose", detail: "This workload is already Compose-managed." };
  }
  if (project.containers.length === 0) {
    return { eligible: false, reason: "no_compose_label", detail: "This workload has no active containers to inspect." };
  }

  const composeLabels = new Set(
    project.containers.map((c) => c.composeProject).filter((v): v is string => Boolean(v))
  );
  if (composeLabels.size === 0) {
    return {
      eligible: false,
      reason: "no_compose_label",
      detail: "None of this workload's containers carry Docker Compose labels."
    };
  }
  if (composeLabels.size > 1) {
    return {
      eligible: false,
      reason: "multiple_compose_projects",
      detail: `This workload's containers span ${composeLabels.size} different Compose projects (${Array.from(composeLabels).join(", ")}) — the mapping is ambiguous.`
    };
  }
  const composeProject = Array.from(composeLabels)[0];

  const nonComposeMembers = project.containers.filter((c) => c.composeProject !== composeProject);
  if (nonComposeMembers.length > 0) {
    return {
      eligible: false,
      reason: "partial_membership",
      detail: `${nonComposeMembers.length} container(s) in this workload do not carry the "${composeProject}" Compose label.`
    };
  }

  const existingCompose = await prisma.project.findFirst({
    where: { nodeId: project.nodeId, composeProject, source: ProjectSource.COMPOSE, NOT: { id: project.id } }
  });
  if (existingCompose) {
    return {
      eligible: false,
      reason: "compose_project_already_adopted_elsewhere",
      detail: `Compose project "${composeProject}" is already tracked by workload "${existingCompose.name}".`
    };
  }

  const allComposeContainers = await prisma.container.findMany({
    where: { nodeId: project.nodeId, composeProject, isActive: true },
    select: { id: true, dockerName: true }
  });
  const memberIds = new Set(project.containers.map((c) => c.id));
  const missing = allComposeContainers.filter((c) => !memberIds.has(c.id));
  if (missing.length > 0) {
    return {
      eligible: false,
      reason: "partial_membership",
      detail: `${missing.length} container(s) belonging to Compose project "${composeProject}" are not currently members of this workload (${missing.map((m) => m.dockerName).join(", ")}). Add them to this workload first, or adopt "${composeProject}" as a separate workload instead.`
    };
  }

  return {
    eligible: true,
    composeProject,
    workloadContainers: project.containers.map((c) => c.dockerName),
    allComposeServices: allComposeContainers.map((c) => c.dockerName)
  };
}

/**
 * Convert a MANUAL workload to COMPOSE in place. Retains id, name, client
 * association, grants and activity history — this is a plain field update,
 * never a create+migrate, so nothing is orphaned. Only proceeds when
 * `previewConvertToCompose` reports `eligible: true`.
 */
export async function convertToComposeManaged(
  projectId: string
): Promise<{ id: string } | { error: string }> {
  const preview = await previewConvertToCompose(projectId);
  if (!preview) return { error: "Workload not found" };
  if (!preview.eligible) return { error: preview.detail };

  await prisma.project.update({
    where: { id: projectId },
    data: { source: ProjectSource.COMPOSE, composeProject: preview.composeProject }
  });

  return { id: projectId };
}

// ---------------------------------------------------------------------------
// Detach (stop automatic Compose tracking)
// ---------------------------------------------------------------------------

/**
 * Detach a COMPOSE workload from automatic reconciliation, converting it back
 * to MANUAL with its currently-known active containers as static membership.
 *
 * This function NEVER touches Docker: it is a pure database update (source →
 * MANUAL, composeProject → null). No container is stopped, no volume or
 * network is removed, no `docker compose down` is ever invoked from this or
 * any code path this function calls. Existing grants, activity history, and
 * the workload id/name are all untouched — only future inventory refreshes
 * stop re-syncing membership for this project (reconcileComposeWorkloads only
 * iterates `source: COMPOSE` projects).
 */
export async function detachComposeTracking(projectId: string): Promise<{ id: string } | null> {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project || project.source !== ProjectSource.COMPOSE) {
    return null;
  }

  await prisma.project.update({
    where: { id: projectId },
    data: { source: ProjectSource.MANUAL, composeProject: null }
  });

  return { id: projectId };
}
