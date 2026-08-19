import { ProjectSource } from "@prisma/client";
import { prisma } from "@/server/db";

/**
 * Compose workload discovery & reconciliation.
 *
 * A Docker Compose project (identified by the `com.docker.compose.project`
 * label) can become a HostPanel workload. Two sources coexist:
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
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "compose";
}

/**
 * Reconcile COMPOSE workloads on a node against the live container inventory.
 * For each existing COMPOSE project on the node, associate current members and
 * mark no-longer-reported members inactive. Returns the number of projects
 * reconciled.
 */
export async function reconcileComposeWorkloads(
  nodeId: string,
  live: ComposeContainerRef[]
): Promise<number> {
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
      await prisma.container.updateMany({
        where: {
          projectId: project.id,
          nodeId,
          isActive: true,
          dockerContainerId: { notIn: members.map((c) => c.id) }
        },
        data: { isActive: false, lastSeenAt: new Date() }
      });
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
export async function recordComposeMetadata(
  nodeId: string,
  live: ComposeContainerRef[]
): Promise<void> {
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

export type DiscoveredComposeProject = {
  nodeId: string;
  nodeName: string;
  composeProject: string;
  containerCount: number;
  adopted: boolean;
  workloadId: string | null;
};

/** List Compose projects detected across nodes, with adoption status. */
export async function listDiscoveredComposeProjects(): Promise<DiscoveredComposeProject[]> {
  const containers = await prisma.container.findMany({
    where: { isActive: true, composeProject: { not: null } },
    select: {
      nodeId: true,
      node: { select: { name: true } },
      composeProject: true
    }
  });

  const projects = await prisma.project.findMany({
    where: { source: ProjectSource.COMPOSE, isActive: true },
    select: { id: true, nodeId: true, composeProject: true }
  });
  const adoptedByNode = new Map<string, string>();
  for (const p of projects) {
    if (p.composeProject) adoptedByNode.set(`${p.nodeId}:${p.composeProject}`, p.id);
  }

  const groups = new Map<string, DiscoveredComposeProject>();
  for (const c of containers) {
    if (!c.composeProject) continue;
    const key = `${c.nodeId}:${c.composeProject}`;
    const existing = groups.get(key);
    if (existing) {
      existing.containerCount += 1;
    } else {
      groups.set(key, {
        nodeId: c.nodeId,
        nodeName: c.node.name,
        composeProject: c.composeProject,
        containerCount: 1,
        adopted: adoptedByNode.has(key),
        workloadId: adoptedByNode.get(key) ?? null
      });
    }
  }

  return Array.from(groups.values()).sort(
    (a, b) => a.nodeName.localeCompare(b.nodeName) || a.composeProject.localeCompare(b.composeProject)
  );
}

/**
 * Adopt a detected Compose project as a COMPOSE workload owned by the given
 * client. Returns the created project, or null when the compose project does
 * not exist on the node or is already adopted.
 */
export async function adoptComposeProject(input: {
  clientAccountId: string;
  nodeId: string;
  composeProject: string;
  name?: string;
  slug?: string;
  description?: string | null;
}): Promise<{ id: string } | null> {
  const members = await prisma.container.findMany({
    where: { nodeId: input.nodeId, composeProject: input.composeProject, isActive: true },
    select: { id: true }
  });
  if (members.length === 0) {
    return null;
  }

  const friendly = input.name?.trim() || input.composeProject;
  const created = await prisma.project.create({
    data: {
      name: friendly,
      slug: input.slug?.trim() || slugify(friendly),
      description: input.description ?? null,
      source: ProjectSource.COMPOSE,
      composeProject: input.composeProject,
      clientAccountId: input.clientAccountId,
      nodeId: input.nodeId,
      isActive: true
    }
  });

  await prisma.container.updateMany({
    where: { id: { in: members.map((m) => m.id) } },
    data: { projectId: created.id, isActive: true }
  });

  return { id: created.id };
}
