import { Role } from "@prisma/client";
import { prisma } from "@/server/db";
import { nodeAgentClient } from "@/server/services/node-agent/client";
import type { AuthSession } from "@/server/auth/session";
import type { RuntimeContainer } from "@/server/services/node-agent/types";

/**
 * Workload Networks & Volumes aggregation (read-only, Phase 4).
 *
 * Design constraints from the brief:
 *  - No N+1 explosion: exactly one `listContainers()` call for the node's
 *    live inventory (which the caller may already have from a snapshot) plus
 *    at most one batched `/networks/inspect` and one batched `/volumes/inspect`
 *    call to the agent, regardless of how many containers the workload has.
 *  - Shared-resource detection: a network/volume is "shared" when containers
 *    outside the workload (on the same node) also reference it. This reuses
 *    the same live inventory snapshot — no extra Docker calls.
 *  - Tenant sanitization: CLIENT roles never receive raw host bind source
 *    paths; ADMIN does. Enforced here (service layer), not just hidden in the
 *    UI, so a crafted request can't extract it either.
 */

export type SharedResourceStatus =
  | { kind: "exclusive" }
  | { kind: "shared_within_workload" } // reserved for future multi-project sharing detection
  | { kind: "shared_with_others"; otherContainerCount: number };

export type WorkloadNetworkView = {
  name: string;
  id: string;
  driver: string;
  scope: string;
  internal: boolean;
  subnets: string[];
  gateways: string[];
  /** Workload containers attached to this network. */
  workloadContainers: string[];
  /** Every container on the node attached to this network (for sharing detection). */
  totalAttachedCount: number;
  shared: SharedResourceStatus;
};

export type WorkloadVolumeMountView =
  | {
      kind: "volume";
      volumeName: string;
      driver: string | null;
      destination: string;
      mode: string;
      /** Workload containers that mount this named volume. */
      workloadContainers: string[];
      shared: SharedResourceStatus;
    }
  | {
      kind: "bind";
      /** Full host path — present only when the caller is ADMIN. */
      sourcePath: string | null;
      /** True when sourcePath was withheld for a non-admin caller. */
      sourceHidden: boolean;
      destination: string;
      mode: string;
      container: string;
    }
  | {
      kind: "tmpfs";
      destination: string;
      container: string;
    };

/**
 * Resolve the live inventory for a node, once. Callers pass an already-loaded
 * snapshot when available (e.g. from `collectOverviewSnapshot`) to avoid a
 * redundant agent round-trip; otherwise this fetches it directly.
 */
async function loadNodeInventory(nodeId: string, preloaded?: RuntimeContainer[]): Promise<RuntimeContainer[]> {
  if (preloaded) return preloaded;
  const node = await prisma.node.findUnique({ where: { id: nodeId } });
  if (!node) return [];
  const payload = await nodeAgentClient.listContainers(node);
  return payload.containers;
}

/**
 * Compute Networks + Volumes for a workload (Project). `session` determines
 * host-path visibility (ADMIN sees bind source paths; CLIENT roles do not).
 * Returns null if the project does not exist.
 */
export async function getWorkloadResources(
  projectId: string,
  session: AuthSession,
  preloadedInventory?: RuntimeContainer[]
): Promise<{ networks: WorkloadNetworkView[]; volumes: WorkloadVolumeMountView[] } | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { containers: { where: { isActive: true }, select: { dockerContainerId: true, dockerName: true } } }
  });
  if (!project) {
    return null;
  }

  const isAdmin = session.role === Role.ADMIN;
  const workloadDockerIds = new Set(project.containers.map((c) => c.dockerContainerId));

  const live = await loadNodeInventory(project.nodeId, preloadedInventory);
  const liveById = new Map(live.map((c) => [c.id, c]));

  // ---- Networks -----------------------------------------------------
  const networkNamesInWorkload = new Set<string>();
  for (const dockerId of workloadDockerIds) {
    const c = liveById.get(dockerId);
    for (const n of c?.networkNames ?? []) {
      networkNamesInWorkload.add(n);
    }
  }

  let networks: WorkloadNetworkView[] = [];
  if (networkNamesInWorkload.size > 0) {
    const node = await prisma.node.findUnique({ where: { id: project.nodeId } });
    const inspected = node
      ? await nodeAgentClient.inspectNetworks(node, Array.from(networkNamesInWorkload))
      : [];
    const inspectedByName = new Map(inspected.map((n) => [n.name, n]));

    // Total-attached count and workload-attached list, computed from the live
    // inventory (no extra agent calls) so shared-resource detection is free.
    const attachedByNetwork = new Map<string, { total: string[]; workload: string[] }>();
    for (const c of live) {
      for (const n of c.networkNames ?? []) {
        if (!networkNamesInWorkload.has(n)) continue;
        const entry = attachedByNetwork.get(n) ?? { total: [], workload: [] };
        entry.total.push(c.name);
        if (workloadDockerIds.has(c.id)) entry.workload.push(c.name);
        attachedByNetwork.set(n, entry);
      }
    }

    networks = Array.from(networkNamesInWorkload)
      .map((name) => {
        const info = inspectedByName.get(name);
        const attached = attachedByNetwork.get(name) ?? { total: [], workload: [] };
        const otherCount = attached.total.length - attached.workload.length;
        return {
          name,
          id: info?.id ?? "",
          driver: info?.driver ?? "unknown",
          scope: info?.scope ?? "unknown",
          internal: info?.internal ?? false,
          subnets: info?.subnets ?? [],
          gateways: info?.gateways ?? [],
          workloadContainers: attached.workload,
          totalAttachedCount: attached.total.length,
          shared: (otherCount > 0
            ? { kind: "shared_with_others", otherContainerCount: otherCount }
            : { kind: "exclusive" }) as SharedResourceStatus
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---- Volumes / mounts ------------------------------------------------
  const namedVolumeNames = new Set<string>();
  const mounts: WorkloadVolumeMountView[] = [];

  for (const dockerId of workloadDockerIds) {
    const c = liveById.get(dockerId);
    if (!c) continue;
    for (const m of c.mountRefs ?? []) {
      if (m.type === "volume" && m.volumeName) {
        namedVolumeNames.add(m.volumeName);
      } else if (m.type === "bind") {
        mounts.push({
          kind: "bind",
          sourcePath: isAdmin ? m.source : null,
          sourceHidden: !isAdmin,
          destination: m.destination,
          mode: m.mode,
          container: c.name
        });
      } else if (m.type === "tmpfs") {
        mounts.push({ kind: "tmpfs", destination: m.destination, container: c.name });
      }
    }
  }

  if (namedVolumeNames.size > 0) {
    const node = await prisma.node.findUnique({ where: { id: project.nodeId } });
    const inspected = node
      ? await nodeAgentClient.inspectVolumes(node, Array.from(namedVolumeNames))
      : [];
    const driverByName = new Map(inspected.map((v) => [v.name, v.driver]));

    // Attachment map for shared-resource detection, computed from the live
    // inventory (no extra agent calls).
    const attachedByVolume = new Map<string, { total: string[]; workload: string[] }>();
    for (const c of live) {
      for (const m of c.mountRefs ?? []) {
        if (m.type !== "volume" || !m.volumeName || !namedVolumeNames.has(m.volumeName)) continue;
        const entry = attachedByVolume.get(m.volumeName) ?? { total: [], workload: [] };
        entry.total.push(c.name);
        if (workloadDockerIds.has(c.id)) entry.workload.push(c.name);
        attachedByVolume.set(m.volumeName, entry);
      }
    }

    for (const dockerId of workloadDockerIds) {
      const c = liveById.get(dockerId);
      if (!c) continue;
      for (const m of c.mountRefs ?? []) {
        if (m.type !== "volume" || !m.volumeName) continue;
        const attached = attachedByVolume.get(m.volumeName) ?? { total: [c.name], workload: [c.name] };
        const otherCount = attached.total.length - attached.workload.length;
        mounts.push({
          kind: "volume",
          volumeName: m.volumeName,
          driver: driverByName.get(m.volumeName) ?? null,
          destination: m.destination,
          mode: m.mode,
          workloadContainers: attached.workload,
          shared: (otherCount > 0
            ? { kind: "shared_with_others", otherContainerCount: otherCount }
            : { kind: "exclusive" }) as SharedResourceStatus
        });
      }
    }
  }

  // De-duplicate volume mounts (same volume can be listed once per
  // container that mounts it — collapse to one row per volume name).
  const volumeRows = new Map<string, Extract<WorkloadVolumeMountView, { kind: "volume" }>>();
  const otherMounts: WorkloadVolumeMountView[] = [];
  for (const m of mounts) {
    if (m.kind === "volume") {
      const existing = volumeRows.get(m.volumeName);
      if (!existing) {
        volumeRows.set(m.volumeName, m);
      }
    } else {
      otherMounts.push(m);
    }
  }

  const volumes: WorkloadVolumeMountView[] = [
    ...Array.from(volumeRows.values()).sort((a, b) => a.volumeName.localeCompare(b.volumeName)),
    ...otherMounts.sort((a, b) => a.destination.localeCompare(b.destination))
  ];

  return { networks, volumes };
}

/**
 * Whether the session may view this project's Networks/Volumes at all
 * (tenant scoping — mirrors the same visibility rule used by workload
 * detail / grants: ADMIN sees everything, CLIENT roles need an active grant
 * on the project or its owning client).
 */
export async function canViewWorkloadResources(session: AuthSession, projectId: string): Promise<boolean> {
  if (session.role === Role.ADMIN) return true;
  if (!session.clientAccountId) return false;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { clientAccountId: true }
  });
  if (!project) return false;
  if (project.clientAccountId === session.clientAccountId) return true;

  const grant = await prisma.accessGrant.findFirst({
    where: { projectId, clientAccountId: session.clientAccountId, isActive: true }
  });
  return Boolean(grant);
}
