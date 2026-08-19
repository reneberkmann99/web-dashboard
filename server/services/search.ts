import { prisma } from "@/server/db";
import type { AuthSession } from "@/server/auth/session";
import { resolveVisibleContainersForSession } from "@/server/services/containers";

/**
 * Global search / command-palette backend.
 *
 * Security invariants:
 *  - ADMIN search spans the whole platform (workloads, containers, nodes,
 *    clients).
 *  - Client search is strictly tenant-scoped: it only ever returns workloads
 *    and containers the caller has been granted, and never nodes or clients.
 *  - Container visibility for clients reuses the same
 *    `resolveVisibleContainersForSession` grant resolution as the container
 *    list/detail routes, so search can never leak a container the user cannot
 *    already see.
 *
 * All queries are bounded (take) and the caller must supply a non-empty query;
 * there is no "return everything" path.
 */

export type SearchResultType = "workload" | "container" | "node" | "client";

export type SearchResultItem = {
  type: SearchResultType;
  id: string;
  title: string;
  subtitle: string | null;
  /** Client-relative path that opens this entity. */
  href: string;
  /** Short contextual tag, e.g. node name, status, client name. */
  meta: string | null;
};

export type SearchGroup = {
  type: SearchResultType;
  label: string;
  items: SearchResultItem[];
};

const MAX_PER_GROUP = 8;

function normalize(q: string): string {
  return q.trim();
}

/** True if the query matches name/slug/description (case-insensitive). */
function matches(query: string, ...fields: Array<string | null | undefined>): boolean {
  const q = query.toLowerCase();
  return fields.some((f) => f && f.toLowerCase().includes(q));
}

export async function searchForAdmin(q: string): Promise<SearchGroup[]> {
  const query = normalize(q);
  if (!query) {
    return [];
  }

  const [projects, containers, nodes, clients] = await Promise.all([
    prisma.project.findMany({
      where: {
        OR: [
          { name: { contains: query, mode: "insensitive" } },
          { slug: { contains: query, mode: "insensitive" } },
          { description: { contains: query, mode: "insensitive" } }
        ]
      },
      take: MAX_PER_GROUP,
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        slug: true,
        node: { select: { name: true } },
        clientAccount: { select: { name: true } }
      }
    }),
    prisma.container.findMany({
      where: {
        isActive: true,
        OR: [
          { dockerName: { contains: query, mode: "insensitive" } },
          { image: { contains: query, mode: "insensitive" } },
          { dockerContainerId: { contains: query, mode: "insensitive" } }
        ]
      },
      take: MAX_PER_GROUP,
      orderBy: { dockerName: "asc" },
      select: {
        id: true,
        nodeId: true,
        dockerContainerId: true,
        dockerName: true,
        image: true,
        lastKnownStatus: true,
        node: { select: { name: true } }
      }
    }),
    prisma.node.findMany({
      where: {
        OR: [
          { name: { contains: query, mode: "insensitive" } },
          { hostname: { contains: query, mode: "insensitive" } }
        ]
      },
      take: MAX_PER_GROUP,
      orderBy: { name: "asc" },
      select: { id: true, name: true, hostname: true, status: true }
    }),
    prisma.clientAccount.findMany({
      where: {
        OR: [
          { name: { contains: query, mode: "insensitive" } },
          { slug: { contains: query, mode: "insensitive" } }
        ]
      },
      take: MAX_PER_GROUP,
      orderBy: { name: "asc" },
      select: { id: true, name: true, slug: true, isActive: true }
    })
  ]);

  const groups: SearchGroup[] = [];

  if (projects.length > 0) {
    groups.push({
      type: "workload",
      label: "Workloads",
      items: projects.map((p) => ({
        type: "workload" as const,
        id: p.id,
        title: p.name,
        subtitle: p.slug,
        href: `/admin/workloads/${p.id}`,
        meta: p.node.name
      }))
    });
  }

  if (containers.length > 0) {
    groups.push({
      type: "container",
      label: "Containers",
      items: containers.map((c) => ({
        type: "container" as const,
        id: c.id,
        title: c.dockerName,
        subtitle: c.image,
        href: `/admin/containers/${c.nodeId}/${c.dockerContainerId}`,
        meta: `${c.node.name}${c.lastKnownStatus ? ` · ${c.lastKnownStatus}` : ""}`
      }))
    });
  }

  if (nodes.length > 0) {
    groups.push({
      type: "node",
      label: "Nodes",
      items: nodes.map((n) => ({
        type: "node" as const,
        id: n.id,
        title: n.name,
        subtitle: n.hostname,
        href: `/admin/nodes/${n.id}`,
        meta: n.status
      }))
    });
  }

  if (clients.length > 0) {
    groups.push({
      type: "client",
      label: "Clients",
      items: clients.map((c) => ({
        type: "client" as const,
        id: c.id,
        title: c.name,
        subtitle: c.slug,
        href: `/admin/clients/${c.id}`,
        meta: c.isActive ? "active" : "inactive"
      }))
    });
  }

  return groups;
}

export async function searchForClient(session: AuthSession, q: string): Promise<SearchGroup[]> {
  const query = normalize(q);
  if (!query) {
    return [];
  }
  const clientId = session.clientAccountId ?? "__invalid__";

  // Workloads: granted project-level access, or projects owned by the client.
  const [grantedProjects, ownedProjects] = await Promise.all([
    prisma.accessGrant.findMany({
      where: { clientAccountId: clientId, isActive: true, projectId: { not: null } },
      select: { projectId: true }
    }),
    prisma.project.findMany({
      where: {
        clientAccountId: clientId,
        isActive: true,
        OR: [
          { name: { contains: query, mode: "insensitive" } },
          { slug: { contains: query, mode: "insensitive" } },
          { description: { contains: query, mode: "insensitive" } }
        ]
      },
      take: MAX_PER_GROUP,
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        slug: true,
        node: { select: { name: true } }
      }
    })
  ]);

  const grantedProjectIds = new Set(
    grantedProjects.map((g) => g.projectId).filter((v): v is string => !!v)
  );

  // Projects granted to us that we haven't already fetched as "owned".
  const visibleProjectIds = new Set<string>(ownedProjects.map((p) => p.id));
  let grantedProjectRows: typeof ownedProjects = [];
  if (grantedProjectIds.size > 0) {
    grantedProjectRows = await prisma.project.findMany({
      where: {
        id: { in: Array.from(grantedProjectIds) },
        isActive: true,
        OR: [
          { name: { contains: query, mode: "insensitive" } },
          { slug: { contains: query, mode: "insensitive" } },
          { description: { contains: query, mode: "insensitive" } }
        ]
      },
      take: MAX_PER_GROUP,
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        slug: true,
        node: { select: { name: true } }
      }
    });
  }

  const groups: SearchGroup[] = [];

  const workloads = [...ownedProjects, ...grantedProjectRows.filter((p) => !visibleProjectIds.has(p.id))];
  if (workloads.length > 0) {
    groups.push({
      type: "workload",
      label: "Workloads",
      items: workloads.slice(0, MAX_PER_GROUP).map((p) => ({
        type: "workload" as const,
        id: p.id,
        title: p.name,
        subtitle: p.slug,
        href: `/client/workloads/${p.id}`,
        meta: p.node.name
      }))
    });
  }

  // Containers: reuse the same grant resolution as the container list route.
  const visible = await resolveVisibleContainersForSession(session);
  const matchingContainers: SearchResultItem[] = [];
  for (const row of visible.values()) {
    if (matches(query, row.dockerName, row.image, row.dockerContainerId)) {
      matchingContainers.push({
        type: "container",
        id: row.grantId,
        title: row.dockerName,
        subtitle: row.image,
        href: `/client/containers/${row.grantId}`,
        meta: row.node.name
      });
      if (matchingContainers.length >= MAX_PER_GROUP) {
        break;
      }
    }
  }
  if (matchingContainers.length > 0) {
    groups.push({ type: "container", label: "Containers", items: matchingContainers });
  }

  return groups;
}
