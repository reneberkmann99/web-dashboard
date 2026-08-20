import { prisma } from "@/server/db";
import { ATTENTION_CONFIG } from "@/server/services/attention-config";
import { logAuditEvent } from "@/server/audit";
import { getCertificateAttentionItems } from "@/server/services/node-tls";
import { clearAcknowledgementsForResolvedState, getLifecyclePolicyContexts, type LifecyclePolicyContext } from "@/server/services/attention-lifecycle";
import { createConditionNotificationEvent } from "@/server/services/notifications";
import type { RuntimeContainer } from "@/server/services/node-agent/types";
import type { OverviewSnapshot, NodeOperationalView } from "@/server/services/overview";
import type { AttentionItem, AttentionSeverity, RecentFailure, ActiveOperationSummary, FleetSummary } from "@/types/domain";

/**
 * Central attention/operational-condition domain service (Phase 6D).
 *
 * This is the ONE place that turns raw Docker/Node/Deployment/Operation
 * state into operator-facing severity. No page, component, or route should
 * reimplement "is this thing broken" logic independently — they call into
 * this module (or read the persisted `AttentionState` rows it maintains) and
 * render what comes back.
 *
 * Two kinds of signal:
 *  1. Point-in-time facts (recent failed operations) — queried fresh each
 *     time from `Operation`/`DeploymentOperation`, windowed by recency. No
 *     "resolution" concept needed since they are inherently terminal events.
 *  2. Ongoing conditions (node offline, container unhealthy, crash-looping,
 *     workload degraded, resource pressure, cert expiry, outdated agent) —
 *     tracked as `AttentionState` rows with open/observe/resolve lifecycle so
 *     the same underlying condition never re-alerts on every poll, and a
 *     transition ("became offline" / "recovered") can be logged to Activity
 *     exactly once (§27) instead of once per poll.
 *
 * See ARCHITECTURE.md "Phase 6D" for the full write-up (severity model,
 * dedup rules, thresholds, resolution behavior, known limitations).
 */

// ---------------------------------------------------------------------------
// Condition types (documented vocabulary — see ARCHITECTURE.md)
// ---------------------------------------------------------------------------

export const CONDITION = {
  NODE_OFFLINE: "NODE_OFFLINE",
  NODE_HEARTBEAT_STALE: "NODE_HEARTBEAT_STALE",
  NODE_DISK_PRESSURE: "NODE_DISK_PRESSURE",
  NODE_CPU_PRESSURE: "NODE_CPU_PRESSURE",
  NODE_MEM_PRESSURE: "NODE_MEM_PRESSURE",
  NODE_AGENT_OUTDATED: "NODE_AGENT_OUTDATED",
  NODE_CERT_EXPIRY: "NODE_CERT_EXPIRY",
  CONTAINER_UNHEALTHY: "CONTAINER_UNHEALTHY",
  CONTAINER_CRASH_LOOP: "CONTAINER_CRASH_LOOP",
  CONTAINER_UNEXPECTED_STOP: "CONTAINER_UNEXPECTED_STOP",
  CONTAINER_STOPPED_INTENTIONAL: "CONTAINER_STOPPED_INTENTIONAL",
  CONTAINER_HIGH_CPU: "CONTAINER_HIGH_CPU",
  CONTAINER_HIGH_MEMORY: "CONTAINER_HIGH_MEMORY",
  WORKLOAD_DEGRADED: "WORKLOAD_DEGRADED",
  WORKLOAD_DRIFTED: "WORKLOAD_DRIFTED",
  DEPLOYMENT_FAILED: "DEPLOYMENT_FAILED",
  OPERATION_STUCK: "OPERATION_STUCK"
} as const;

export type ConditionType = (typeof CONDITION)[keyof typeof CONDITION];

export type ResourceType = "NODE" | "CONTAINER" | "WORKLOAD" | "OPERATION" | "DEPLOYMENT";

export type DerivedCondition = {
  resourceType: ResourceType;
  /** Stable identity within resourceType. Containers use `${nodeId}:${dockerContainerId}` (not every discovered container has a Container row). */
  resourceId: string;
  conditionType: ConditionType;
  severity: AttentionSeverity;
  title: string;
  detail: string;
  nodeId: string | null;
  metadata?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Restart-rate tracking (§8)
// ---------------------------------------------------------------------------

/**
 * Record a restart sample for every container whose cumulative RestartCount
 * increased since the last recorded sample. Cheap: one query + bounded
 * writes per node poll, not per-poll-per-container. Deployment-driven
 * restarts are not filtered out here (that would lose the raw signal); the
 * post-deploy suppression window is applied when READING the rate, not when
 * writing samples — see `getRestartRateWarnings`.
 */
export async function recordRestartSamples(nodeId: string, containers: RuntimeContainer[]): Promise<void> {
  // Record the first observed cumulative count even when it is zero. That
  // establishes a baseline before a loop begins, so 0 -> 3 inside the window
  // is correctly reported as three recent restarts while a container first
  // discovered at lifetime count 12 starts with a baseline of 12 (and does
  // not falsely look like 12 recent restarts).
  const withRestarts = containers.filter((c) => typeof c.restartCount === "number");
  if (withRestarts.length === 0) return;

  const latest = await prisma.containerRestartSample.findMany({
    where: { nodeId, dockerContainerId: { in: withRestarts.map((c) => c.id) } },
    orderBy: { observedAt: "desc" },
    distinct: ["dockerContainerId"],
    select: { dockerContainerId: true, restartCount: true }
  });
  const lastSeen = new Map(latest.map((s) => [s.dockerContainerId, s.restartCount]));

  const toCreate = withRestarts
    .filter((c) => (lastSeen.get(c.id) ?? -1) < c.restartCount!)
    .map((c) => ({ nodeId, dockerContainerId: c.id, restartCount: c.restartCount! }));

  if (toCreate.length > 0) {
    await prisma.containerRestartSample.createMany({ data: toCreate });
  }
}

/** Prune restart samples older than the retention window. Call from the throttled sync pass. */
export async function pruneOldSamples(): Promise<void> {
  const restartCutoff = new Date(Date.now() - ATTENTION_CONFIG.restartLoop.sampleRetentionMs);
  const resourceCutoff = new Date(Date.now() - ATTENTION_CONFIG.nodeResource.sampleRetentionMs);
  await Promise.all([
    prisma.containerRestartSample.deleteMany({ where: { observedAt: { lt: restartCutoff } } }),
    prisma.nodeResourceSample.deleteMany({ where: { observedAt: { lt: resourceCutoff } } })
  ]);
}

type RestartRate = { key: string; nodeId: string; dockerContainerId: string; restartsInWindow: number };

/**
 * Restarts observed within the rolling window, per container. A container
 * that has "restarted 12 times historically" but 0 in the window returns 0
 * here — this function answers the operationally important question
 * ("restarted 8 times in the last 10 minutes"), not the lifetime counter.
 */
async function getRestartRates(nodeIds: string[]): Promise<Map<string, RestartRate>> {
  if (nodeIds.length === 0) return new Map();
  const windowStart = new Date(Date.now() - ATTENTION_CONFIG.restartLoop.windowMs);
  const samples = await prisma.containerRestartSample.findMany({
    where: { nodeId: { in: nodeIds }, observedAt: { gte: windowStart } },
    orderBy: { observedAt: "asc" },
    select: { nodeId: true, dockerContainerId: true, restartCount: true, observedAt: true }
  });

  // Restarts in the window = increase from the first sample inside the
  // window to the last — NOT a count of rows (a row is written once per
  // observed increase, so counting rows already approximates delta, but
  // using first/last is robust to any future batching changes).
  const byContainer = new Map<string, { first: number; last: number }>();
  for (const s of samples) {
    const key = `${s.nodeId}:${s.dockerContainerId}`;
    const entry = byContainer.get(key);
    if (!entry) {
      byContainer.set(key, { first: s.restartCount, last: s.restartCount });
    } else {
      entry.last = s.restartCount;
    }
  }

  const out = new Map<string, RestartRate>();
  for (const [key, { first, last }] of byContainer) {
    const [nodeId, dockerContainerId] = key.split(":");
    out.set(key, { key, nodeId, dockerContainerId, restartsInWindow: Math.max(0, last - first) });
  }
  return out;
}

/**
 * True when a container recently completed a deployment/workload-restart
 * operation successfully — used to suppress false crash-loop alarms right
 * after a deliberate redeploy or restart (§8: "Avoid false alarms
 * immediately after deliberate deployments/restarts").
 */
async function recentlyDeployedContainerIds(nodeIds: string[]): Promise<Set<string>> {
  if (nodeIds.length === 0) return new Set();
  const since = new Date(Date.now() - ATTENTION_CONFIG.restartLoop.postDeploySuppressMs);
  const [ops, deployOps] = await Promise.all([
    prisma.operation.findMany({
      where: {
        nodeId: { in: nodeIds },
        type: "CONTAINER_RESTART",
        state: "SUCCEEDED",
        finishedAt: { gte: since }
      },
      select: { nodeId: true, dockerContainerId: true }
    }),
    // A deployment apply/rollback that succeeded recently touches every
    // container in that workload's compose project — suppress the whole
    // project's containers, not just ones with a matching Operation row
    // (managed deployments restart containers via `docker compose`, not the
    // Operation queue).
    prisma.deploymentOperation.findMany({
      where: { state: "SUCCEEDED", finishedAt: { gte: since } },
      select: {
        deployment: {
          select: {
            project: {
              select: {
                nodeId: true,
                containers: { where: { isActive: true }, select: { dockerContainerId: true } }
              }
            }
          }
        }
      }
    })
  ]);
  const set = new Set(ops.map((o) => `${o.nodeId}:${o.dockerContainerId}`));
  for (const d of deployOps) {
    const project = d.deployment?.project;
    if (!project) continue;
    for (const c of project.containers) {
      set.add(`${project.nodeId}:${c.dockerContainerId}`);
    }
  }
  return set;
}

// ---------------------------------------------------------------------------
// Node resource pressure (§9)
// ---------------------------------------------------------------------------

export async function recordNodeResourceSample(
  nodeId: string,
  sample: { cpuPercent: number | null; memPercent: number | null; diskPercent: number | null },
  force = false
): Promise<void> {
  if (sample.cpuPercent === null && sample.memPercent === null && sample.diskPercent === null) return;
  if (!force) {
    const latest = await prisma.nodeResourceSample.findFirst({
      where: { nodeId },
      orderBy: { observedAt: "desc" },
      select: { observedAt: true }
    });
    if (latest && Date.now() - latest.observedAt.getTime() < ATTENTION_CONFIG.nodeResource.sampleIntervalMs) {
      return;
    }
  }
  await prisma.nodeResourceSample.create({
    data: { nodeId, cpuPercent: sample.cpuPercent, memPercent: sample.memPercent, diskPercent: sample.diskPercent }
  });
}

type SustainedPressure = { cpu: number | null; mem: number | null; disk: number | null; sampleCount: number };

/**
 * Average of samples inside the sustained-pressure window. A single spike
 * that immediately drops back never crosses this because the window average
 * dilutes it — deliberately conservative (brief §9: "A 95% CPU spike lasting
 * one poll should not generate a scary alert").
 */
async function getSustainedNodePressure(nodeIds: string[]): Promise<Map<string, SustainedPressure>> {
  if (nodeIds.length === 0) return new Map();
  const windowStart = new Date(Date.now() - ATTENTION_CONFIG.nodeResource.sustainedWindowMs);
  const samples = await prisma.nodeResourceSample.findMany({
    where: { nodeId: { in: nodeIds }, observedAt: { gte: windowStart } },
    select: { nodeId: true, cpuPercent: true, memPercent: true, diskPercent: true }
  });
  const byNode = new Map<string, { cpu: number[]; mem: number[]; disk: number[] }>();
  for (const s of samples) {
    const entry = byNode.get(s.nodeId) ?? { cpu: [], mem: [], disk: [] };
    if (s.cpuPercent !== null) entry.cpu.push(s.cpuPercent);
    if (s.memPercent !== null) entry.mem.push(s.memPercent);
    if (s.diskPercent !== null) entry.disk.push(s.diskPercent);
    byNode.set(s.nodeId, entry);
  }
  const avg = (arr: number[]): number | null => (arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  const out = new Map<string, SustainedPressure>();
  for (const [nodeId, entry] of byNode) {
    out.set(nodeId, {
      cpu: avg(entry.cpu),
      mem: avg(entry.mem),
      disk: avg(entry.disk),
      sampleCount: Math.max(entry.cpu.length, entry.mem.length, entry.disk.length)
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

function href(resourceType: ResourceType, id: string, role: "ADMIN" | "CLIENT"): string | null {
  const base = role === "ADMIN" ? "/admin" : "/client";
  switch (resourceType) {
    case "NODE":
      return role === "ADMIN" ? `${base}/nodes/${id}` : null; // node infra hidden from clients
    case "WORKLOAD":
      return `${base}/workloads/${id}`;
    case "CONTAINER": {
      const [nodeId, dockerId] = id.split(":");
      return role === "ADMIN" ? `${base}/containers/${nodeId}/${dockerId}` : null;
    }
    case "OPERATION":
      return role === "ADMIN" ? `${base}/activity?containerId=${id.split(":")[1] ?? id}` : null;
    case "DEPLOYMENT":
      return null;
    default:
      return null;
  }
}

/** Derive node-level conditions: offline/stale heartbeat, resource pressure, outdated agent, cert expiry. */
export async function deriveNodeConditions(nodes: NodeOperationalView[]): Promise<DerivedCondition[]> {
  const conditions: DerivedCondition[] = [];
  const activeNodes = nodes.filter((n) => n.isActive);
  const pressureByNode = await getSustainedNodePressure(activeNodes.map((n) => n.id));
  const certItems = await getCertificateAttentionItems();
  const cfg = ATTENTION_CONFIG.nodeResource;

  for (const node of activeNodes) {
    if (node.heartbeatState === "OFFLINE") {
      conditions.push({
        resourceType: "NODE",
        resourceId: node.id,
        conditionType: CONDITION.NODE_OFFLINE,
        severity: "critical",
        title: `${node.name} is offline`,
        detail: node.lastHeartbeatAt
          ? `Last heartbeat ${timeAgo(node.lastHeartbeatAt)}. ${node.containerCount} container${node.containerCount === 1 ? "" : "s"} affected.`
          : "No heartbeat recorded yet.",
        nodeId: node.id,
        metadata: { affectedCount: node.containerCount }
      });
      continue; // don't also raise resource-pressure/version conditions for an offline node
    }
    if (node.heartbeatState === "STALE") {
      conditions.push({
        resourceType: "NODE",
        resourceId: node.id,
        conditionType: CONDITION.NODE_HEARTBEAT_STALE,
        severity: "warning",
        title: `${node.name} heartbeat is stale`,
        detail: `Last heartbeat ${timeAgo(node.lastHeartbeatAt!)} — approaching the offline threshold.`,
        nodeId: node.id
      });
    }

    const pressure = pressureByNode.get(node.id);
    if (pressure && pressure.sampleCount >= cfg.minSamplesForSustained) {
      if (pressure.disk !== null) {
        if (pressure.disk >= cfg.diskCriticalPercent) {
          conditions.push(diskCondition(node, pressure.disk, "critical"));
        } else if (pressure.disk >= cfg.diskWarningPercent) {
          conditions.push(diskCondition(node, pressure.disk, "warning"));
        }
      }
      if (pressure.cpu !== null) {
        if (pressure.cpu >= cfg.cpuCriticalPercent) {
          conditions.push(cpuCondition(node, pressure.cpu, "critical"));
        } else if (pressure.cpu >= cfg.cpuWarningPercent) {
          conditions.push(cpuCondition(node, pressure.cpu, "warning"));
        }
      }
      if (pressure.mem !== null) {
        if (pressure.mem >= cfg.memCriticalPercent) {
          conditions.push(memCondition(node, pressure.mem, "critical"));
        } else if (pressure.mem >= cfg.memWarningPercent) {
          conditions.push(memCondition(node, pressure.mem, "warning"));
        }
      }
    }

    if (node.agentVersion && node.agentVersion !== ATTENTION_CONFIG.agentVersion.current) {
      conditions.push({
        resourceType: "NODE",
        resourceId: node.id,
        conditionType: CONDITION.NODE_AGENT_OUTDATED,
        severity: "warning",
        title: `${node.name} agent is outdated`,
        detail: `Running agent v${node.agentVersion}, current is v${ATTENTION_CONFIG.agentVersion.current}.`,
        nodeId: node.id
      });
    }
  }

  for (const cert of certItems) {
    conditions.push({
      resourceType: "NODE",
      resourceId: cert.nodeId,
      conditionType: CONDITION.NODE_CERT_EXPIRY,
      severity: cert.severity,
      title: `${cert.nodeName} agent certificate`,
      detail: cert.detail,
      nodeId: cert.nodeId
    });
  }

  return conditions;
}

function diskCondition(node: NodeOperationalView, pct: number, severity: AttentionSeverity): DerivedCondition {
  return {
    resourceType: "NODE",
    resourceId: node.id,
    conditionType: CONDITION.NODE_DISK_PRESSURE,
    severity,
    title: `${node.name} disk usage ${pct.toFixed(0)}%`,
    detail: `Sustained disk usage at ${pct.toFixed(0)}%. Full Docker hosts cause real operational failures — reclaim space soon.`,
    nodeId: node.id
  };
}
function cpuCondition(node: NodeOperationalView, pct: number, severity: AttentionSeverity): DerivedCondition {
  return {
    resourceType: "NODE",
    resourceId: node.id,
    conditionType: CONDITION.NODE_CPU_PRESSURE,
    severity,
    title: `${node.name} CPU usage ${pct.toFixed(0)}%`,
    detail: `Sustained CPU pressure at ${pct.toFixed(0)}% over the last ${Math.round(ATTENTION_CONFIG.nodeResource.sustainedWindowMs / 60_000)} min.`,
    nodeId: node.id
  };
}
function memCondition(node: NodeOperationalView, pct: number, severity: AttentionSeverity): DerivedCondition {
  return {
    resourceType: "NODE",
    resourceId: node.id,
    conditionType: CONDITION.NODE_MEM_PRESSURE,
    severity,
    title: `${node.name} memory usage ${pct.toFixed(0)}%`,
    detail: `Sustained memory pressure at ${pct.toFixed(0)}% over the last ${Math.round(ATTENTION_CONFIG.nodeResource.sustainedWindowMs / 60_000)} min.`,
    nodeId: node.id
  };
}

/**
 * Derive container-level conditions for every container on ONLINE nodes.
 * Containers on an offline node are intentionally skipped (§4 dedup): the
 * single node-level NODE_OFFLINE condition already communicates the impact,
 * and per-container "unreachable" cards would just be noise.
 */
export async function deriveContainerConditions(snapshot: OverviewSnapshot): Promise<DerivedCondition[]> {
  const conditions: DerivedCondition[] = [];
  const onlineNodes = snapshot.nodes.filter((n) => n.isActive && n.polledOnline && !n.offline);
  const nodeIds = onlineNodes.map((n) => n.id);

  const [restartRates, suppressed] = await Promise.all([
    getRestartRates(nodeIds),
    recentlyDeployedContainerIds(nodeIds)
  ]);
  const { warningCount, criticalCount } = ATTENTION_CONFIG.restartLoop;
  const { sustainedSamples, cpuWarningPercent, memWarningPercent, memCriticalPercent } = ATTENTION_CONFIG.containerResource;

  for (const node of onlineNodes) {
    const containers = snapshot.containersByNode.get(node.id) ?? [];
    for (const c of containers) {
      const key = `${node.id}:${c.id}`;
      if (c.health === "unhealthy" || c.status === "unhealthy") {
        conditions.push({
          resourceType: "CONTAINER",
          resourceId: key,
          conditionType: CONDITION.CONTAINER_UNHEALTHY,
          severity: "warning",
          title: `${c.name} is unhealthy`,
          detail: `On ${node.name}. Health check failing.`,
          nodeId: node.id
        });
      }

      const rate = restartRates.get(key);
      const isSuppressed = suppressed.has(key);
      if (rate && rate.restartsInWindow >= warningCount && !isSuppressed) {
        const severity: AttentionSeverity = rate.restartsInWindow >= criticalCount ? "critical" : "warning";
        conditions.push({
          resourceType: "CONTAINER",
          resourceId: key,
          conditionType: CONDITION.CONTAINER_CRASH_LOOP,
          severity,
          title: `${c.name} is crash-looping`,
          detail: `On ${node.name}. ${rate.restartsInWindow} restart${rate.restartsInWindow === 1 ? "" : "s"} in the last ${Math.round(ATTENTION_CONFIG.restartLoop.windowMs / 60_000)} min.`,
          nodeId: node.id,
          metadata: { restartsInWindow: rate.restartsInWindow }
        });
      }

      if (c.status === "stopped") {
        const expectedRunning = c.restartPolicy === "always" || c.restartPolicy === "unless-stopped";
        if (expectedRunning) {
          conditions.push({
            resourceType: "CONTAINER",
            resourceId: key,
            conditionType: CONDITION.CONTAINER_UNEXPECTED_STOP,
            severity: "critical",
            title: `${c.name} stopped unexpectedly`,
            detail: `On ${node.name}. Restart policy is "${c.restartPolicy}" but the container is not running.`,
            nodeId: node.id
          });
        } else {
          conditions.push({
            resourceType: "CONTAINER",
            resourceId: key,
            conditionType: CONDITION.CONTAINER_STOPPED_INTENTIONAL,
            severity: "info",
            title: `${c.name} is stopped`,
            detail: `On ${node.name}.`,
            nodeId: node.id
          });
        }
      }

      const observedCpuPercent = c.cpuPercent;
      const highCpuSamples = observeContainerCpu(key, observedCpuPercent, cpuWarningPercent);
      if (highCpuSamples >= sustainedSamples) {
        conditions.push({
          resourceType: "CONTAINER",
          resourceId: key,
          conditionType: CONDITION.CONTAINER_HIGH_CPU,
          severity: "warning",
          title: `${c.name} high CPU usage`,
          detail: `On ${node.name}. ${observedCpuPercent?.toFixed(0) ?? "—"}% CPU sustained across ${highCpuSamples} observations.`,
          nodeId: node.id
        });
      }

      const memoryPercent = parseMemoryPercent(c.memoryUsage);
      const highMemorySamples = observeContainerMemory(key, memoryPercent, memWarningPercent);
      if (highMemorySamples >= sustainedSamples && memoryPercent !== null) {
        conditions.push({
          resourceType: "CONTAINER",
          resourceId: key,
          conditionType: CONDITION.CONTAINER_HIGH_MEMORY,
          severity: memoryPercent >= memCriticalPercent ? "critical" : "warning",
          title: `${c.name} high memory usage`,
          detail: `On ${node.name}. ${memoryPercent.toFixed(0)}% of its memory limit sustained across ${highMemorySamples} observations.`,
          nodeId: node.id
        });
      }
    }
  }

  return conditions;
}

type ContainerCpuObservation = { consecutiveHigh: number; lastObservedAt: number };
const containerCpuObservations = new Map<string, ContainerCpuObservation>();
const containerMemoryObservations = new Map<string, ContainerCpuObservation>();

function observeContainerCpu(key: string, cpuPercent: number | null, threshold: number): number {
  const prior = containerCpuObservations.get(key);
  const consecutiveHigh = typeof cpuPercent === "number" && cpuPercent >= threshold
    ? (prior?.consecutiveHigh ?? 0) + 1
    : 0;
  containerCpuObservations.set(key, { consecutiveHigh, lastObservedAt: Date.now() });

  // Keep memory bounded when containers disappear. This runs opportunistically
  // during polls and avoids a timer per container.
  if (containerCpuObservations.size > 5_000) {
    const cutoff = Date.now() - 30 * 60_000;
    for (const [trackedKey, observation] of containerCpuObservations) {
      if (observation.lastObservedAt < cutoff) containerCpuObservations.delete(trackedKey);
    }
  }
  return consecutiveHigh;
}

function observeContainerMemory(key: string, memoryPercent: number | null, threshold: number): number {
  const prior = containerMemoryObservations.get(key);
  const consecutiveHigh = typeof memoryPercent === "number" && memoryPercent >= threshold
    ? (prior?.consecutiveHigh ?? 0) + 1
    : 0;
  containerMemoryObservations.set(key, { consecutiveHigh, lastObservedAt: Date.now() });
  if (containerMemoryObservations.size > 5_000) {
    const cutoff = Date.now() - 30 * 60_000;
    for (const [trackedKey, observation] of containerMemoryObservations) {
      if (observation.lastObservedAt < cutoff) containerMemoryObservations.delete(trackedKey);
    }
  }
  return consecutiveHigh;
}

function parseMemoryPercent(value: string | null): number | null {
  if (!value?.includes("/")) return null;
  const [usedRaw, limitRaw] = value.split("/", 2).map((part) => part.trim());
  const parseBytes = (raw: string): number | null => {
    const match = raw.match(/^([\d.]+)\s*([KMGT]?i?B)$/i);
    if (!match) return null;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount)) return null;
    const unit = match[2].toUpperCase();
    const factors: Record<string, number> = {
      B: 1,
      KB: 1_000,
      KIB: 1024,
      MB: 1_000_000,
      MIB: 1024 ** 2,
      GB: 1_000_000_000,
      GIB: 1024 ** 3,
      TB: 1_000_000_000_000,
      TIB: 1024 ** 4
    };
    return amount * (factors[unit] ?? 0);
  };
  const used = parseBytes(usedRaw);
  const limit = parseBytes(limitRaw);
  return used !== null && limit !== null && limit > 0 ? (used / limit) * 100 : null;
}

/**
 * Derive workload-level conditions from managed runtime state and member
 * container conditions. This is the grouping boundary used by Overview:
 * one unhealthy/crash-looping service becomes one workload issue, while the
 * container condition remains available for container detail and badges.
 */
export async function deriveWorkloadConditions(
  snapshot?: OverviewSnapshot,
  containerConditions: DerivedCondition[] = []
): Promise<DerivedCondition[]> {
  const conditions: DerivedCondition[] = [];
  const projects = await prisma.project.findMany({
    where: { isActive: true },
    select: {
      id: true,
      name: true,
      nodeId: true,
      node: { select: { isActive: true } },
      deployment: { select: { id: true, runtimeState: true, currentReleaseId: true } },
      containers: { where: { isActive: true }, select: { dockerContainerId: true, dockerName: true } }
    }
  });
  const nodeById = new Map(snapshot?.nodes.map((node) => [node.id, node]) ?? []);
  const containerConditionByKey = new Map<string, DerivedCondition[]>();
  for (const condition of containerConditions) {
    if (condition.resourceType !== "CONTAINER") continue;
    const list = containerConditionByKey.get(condition.resourceId) ?? [];
    list.push(condition);
    containerConditionByKey.set(condition.resourceId, list);
  }

  for (const project of projects) {
    if (!project.node.isActive) continue;
    const node = nodeById.get(project.nodeId);
    // Node-offline is the root problem and owns the Overview card.
    if (node?.offline) continue;

    const memberKeys = project.containers.map((c) => `${project.nodeId}:${c.dockerContainerId}`);
    const memberConditions = memberKeys.flatMap((key) => containerConditionByKey.get(key) ?? []);
    const actionableMemberConditions = memberConditions.filter((c) => c.severity === "critical" || c.severity === "warning");
    const worstMember = [...actionableMemberConditions].sort(
      (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    )[0];

    if (project.deployment?.runtimeState === "DRIFTED") {
      conditions.push({
        resourceType: "WORKLOAD",
        resourceId: project.id,
        conditionType: CONDITION.WORKLOAD_DRIFTED,
        severity: "critical",
        title: `${project.name} runtime diverged`,
        detail: "The managed deployment runtime seriously diverged from the last known-good configuration.",
        nodeId: project.nodeId,
        metadata: { nodeId: project.nodeId, affectedContainerKeys: memberKeys }
      });
    } else if (project.deployment?.runtimeState === "DEGRADED") {
      conditions.push({
        resourceType: "WORKLOAD",
        resourceId: project.id,
        conditionType: CONDITION.WORKLOAD_DEGRADED,
        severity: "warning",
        title: `${project.name} deployment is degraded`,
        detail: "The current release is running but health verification failed.",
        nodeId: project.nodeId,
        metadata: { nodeId: project.nodeId, affectedContainerKeys: memberKeys }
      });
    } else if (worstMember) {
      conditions.push({
        resourceType: "WORKLOAD",
        resourceId: project.id,
        conditionType: CONDITION.WORKLOAD_DEGRADED,
        severity: worstMember.severity,
        title: `${project.name} requires attention`,
        detail: `${worstMember.title}. ${worstMember.detail}`,
        nodeId: project.nodeId,
        metadata: {
          nodeId: project.nodeId,
          affectedContainerKeys: memberKeys,
          rootConditionType: worstMember.conditionType,
          affectedCount: actionableMemberConditions.length
        }
      });
    }
  }

  // Deployment operations that failed and never converged (currentReleaseId
  // still null while an operation just FAILED) — distinct from ordinary
  // DEGRADED (which means it converged but unhealthy).
  const failedOps = await prisma.deploymentOperation.findMany({
    // Ongoing condition, not the 24h Recent Failures view: if no release ever
    // converged, the last failure remains critical until a release succeeds.
    where: { state: "FAILED" },
    orderBy: { requestedAt: "desc" },
    select: {
      deploymentId: true,
      deployment: {
        select: {
          projectId: true,
          currentReleaseId: true,
          project: { select: { name: true, nodeId: true, isActive: true, node: { select: { isActive: true } } } }
        }
      }
    }
  });
  const seen = new Set<string>();
  for (const op of failedOps) {
    if (!op.deployment?.project.isActive || !op.deployment.project.node.isActive) continue;
    if (op.deployment.currentReleaseId) continue; // it did converge previously; DEGRADED/healthy covers this
    if (seen.has(op.deploymentId)) continue;
    seen.add(op.deploymentId);
    conditions.push({
      resourceType: "WORKLOAD",
      resourceId: op.deployment.projectId,
      conditionType: CONDITION.DEPLOYMENT_FAILED,
      severity: "critical",
      title: `${op.deployment.project.name} deployment failed`,
      detail: "The deployment failed and the runtime never converged to a known release.",
      nodeId: op.deployment.project.nodeId
    });
  }

  return conditions;
}

/** Operations stuck beyond their allowed timeout (§1). */
export async function deriveOperationConditions(): Promise<DerivedCondition[]> {
  const conditions: DerivedCondition[] = [];
  const { containerOpStuckAfterMs, deploymentOpStuckAfterMs } = ATTENTION_CONFIG.operation;

  const stuckContainerOps = await prisma.operation.findMany({
    where: {
      state: { in: ["REQUESTED", "QUEUED", "RUNNING"] },
      requestedAt: { lt: new Date(Date.now() - containerOpStuckAfterMs) }
    },
    select: { id: true, type: true, nodeId: true, dockerContainerId: true, requestedAt: true, node: { select: { name: true } } }
  });
  for (const op of stuckContainerOps) {
    conditions.push({
      resourceType: "OPERATION",
      resourceId: op.id,
      conditionType: CONDITION.OPERATION_STUCK,
      severity: "critical",
      title: `${op.type.replace("CONTAINER_", "").toLowerCase()} operation stuck`,
      detail: `On ${op.node.name}. Requested ${timeAgo(op.requestedAt)} and still not complete.`,
      nodeId: op.nodeId
    });
  }

  const stuckDeployOps = await prisma.deploymentOperation.findMany({
    where: {
      state: { in: ["REQUESTED", "QUEUED", "RUNNING"] },
      requestedAt: { lt: new Date(Date.now() - deploymentOpStuckAfterMs) }
    },
    select: {
      id: true,
      type: true,
      requestedAt: true,
      deployment: { select: { projectId: true, project: { select: { name: true, nodeId: true } } } }
    }
  });
  for (const op of stuckDeployOps) {
    conditions.push({
      resourceType: "OPERATION",
      resourceId: op.id,
      conditionType: CONDITION.OPERATION_STUCK,
      severity: "critical",
      title: `${op.type.toLowerCase()} stuck on ${op.deployment.project.name}`,
      detail: `Requested ${timeAgo(op.requestedAt)} and still not complete.`,
      nodeId: op.deployment.project.nodeId
    });
  }

  return conditions;
}

// ---------------------------------------------------------------------------
// Sync: persist AttentionState transitions + Activity logging (§26/§27)
// ---------------------------------------------------------------------------

/**
 * Reconcile derived conditions against persisted AttentionState rows:
 *  - new condition          → create row, log Activity "became X"
 *  - still-active condition → bump lastObservedAt only (no Activity spam)
 *  - condition no longer present → set resolvedAt, log Activity "recovered"
 *
 * This is the ONLY place that writes AttentionState or logs operational
 * transition events — callers pass in every currently-derived condition for
 * a given sync pass (nodes + containers + workloads + operations together),
 * so resolution is computed correctly (a condition absent from the input is
 * treated as resolved).
 */
export async function syncAttentionState(conditions: DerivedCondition[], preserveNodeIds = new Set<string>()): Promise<void> {
  const now = new Date();
  const activeKeys = new Set(conditions.map((c) => `${c.resourceType}:${c.resourceId}:${c.conditionType}`));

  const existing = await prisma.attentionState.findMany({ where: { resolvedAt: null } });
  const existingByKey = new Map(existing.map((e) => [`${e.resourceType}:${e.resourceId}:${e.conditionType}`, e]));

  // Open or refresh.
  for (const c of conditions) {
    const key = `${c.resourceType}:${c.resourceId}:${c.conditionType}`;
    const prior = existingByKey.get(key);
    if (!prior) {
      const opened = await prisma.attentionState.upsert({
        where: { resourceType_resourceId_conditionType: { resourceType: c.resourceType, resourceId: c.resourceId, conditionType: c.conditionType } },
        create: {
          resourceType: c.resourceType,
          resourceId: c.resourceId,
          conditionType: c.conditionType,
          severity: c.severity.toUpperCase() as "CRITICAL" | "WARNING" | "INFO",
          title: c.title,
          detail: c.detail,
          metadata: { ...(c.metadata ?? {}), nodeId: c.nodeId },
          firstObservedAt: now,
          lastObservedAt: now,
          resolvedAt: null
        },
        // A previously-resolved row re-opening: clear resolvedAt, reset firstObservedAt.
        update: {
          severity: c.severity.toUpperCase() as "CRITICAL" | "WARNING" | "INFO",
          title: c.title,
          detail: c.detail,
          metadata: { ...(c.metadata ?? {}), nodeId: c.nodeId },
          firstObservedAt: now,
          lastObservedAt: now,
          resolvedAt: null
        }
      });
      if (c.severity !== "info") {
        await logTransition(c, "became", c.nodeId);
      }
      await createConditionNotificationEvent({
        state: opened,
        type: "CONDITION_OPENED",
        dedupeKey: `${opened.id}:opened:${opened.firstObservedAt.toISOString()}`,
        occurredAt: opened.firstObservedAt
      });
    } else {
      // Still active — refresh detail/severity/lastObservedAt only; never
      // spam Activity for an already-open condition.
      if (
        prior.severity !== (c.severity.toUpperCase() as string) ||
        prior.detail !== c.detail ||
        Date.now() - prior.lastObservedAt.getTime() > 60_000
      ) {
        const refreshed = await prisma.attentionState.update({
          where: { id: prior.id },
          data: {
            severity: c.severity.toUpperCase() as "CRITICAL" | "WARNING" | "INFO",
            title: c.title,
            detail: c.detail,
            metadata: { ...(c.metadata ?? {}), nodeId: c.nodeId },
            lastObservedAt: now
          }
        });
        const priorRank = prior.severity === "CRITICAL" ? 2 : prior.severity === "WARNING" ? 1 : 0;
        const refreshedRank = refreshed.severity === "CRITICAL" ? 2 : refreshed.severity === "WARNING" ? 1 : 0;
        if (refreshedRank > priorRank) {
          await createConditionNotificationEvent({
            state: refreshed,
            type: "SEVERITY_ESCALATED",
            dedupeKey: `${refreshed.id}:escalated:${prior.severity}:${refreshed.severity}:${refreshed.lastObservedAt.toISOString()}`,
            occurredAt: refreshed.lastObservedAt
          });
        }
      }
    }
  }

  // Resolve anything no longer derived.
  for (const [key, prior] of existingByKey) {
    if (activeKeys.has(key)) continue;
    const priorNodeId = extractNodeIdFromMetadata(prior.metadata);
    if (
      priorNodeId &&
      preserveNodeIds.has(priorNodeId) &&
      (prior.resourceType === "CONTAINER" || prior.resourceType === "WORKLOAD")
    ) {
      // This poll failed but the node is still within heartbeat grace. We
      // have no fresh evidence that a prior service condition recovered, so
      // preserve it until telemetry resumes or the node becomes OFFLINE.
      continue;
    }
    const resolved = await prisma.attentionState.update({ where: { id: prior.id }, data: { resolvedAt: now } });
    await clearAcknowledgementsForResolvedState(prior.id, now);
    await createConditionNotificationEvent({
      state: resolved,
      type: "CONDITION_RESOLVED",
      dedupeKey: `${resolved.id}:resolved:${now.toISOString()}`,
      occurredAt: now
    });
    if (prior.severity !== "INFO") {
      await logTransition(
        {
          resourceType: prior.resourceType,
          resourceId: prior.resourceId,
          conditionType: prior.conditionType as ConditionType,
          severity: "info",
          title: prior.title,
          detail: prior.detail,
          nodeId: null
        },
        "recovered",
        extractNodeIdFromMetadata(prior.metadata)
      );
    }
  }
}

function extractNodeIdFromMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const nodeId = (metadata as Record<string, unknown>).nodeId;
  return typeof nodeId === "string" ? nodeId : null;
}

async function logTransition(c: DerivedCondition, verb: "became" | "recovered", nodeId: string | null): Promise<void> {
  const action = verb === "became" ? `ATTENTION_OPENED_${c.conditionType}` : `ATTENTION_RESOLVED_${c.conditionType}`;
  await logAuditEvent({
    action,
    targetType: c.resourceType,
    targetId: c.resourceId,
    metadata: { conditionType: c.conditionType, severity: c.severity, title: c.title, nodeId },
    result: "SUCCESS"
  }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Full sync pass (throttled, called from the same place inventory refreshes)
// ---------------------------------------------------------------------------

let lastSyncAt = 0;

export async function syncAttentionIfDue(snapshot: OverviewSnapshot): Promise<void> {
  const now = Date.now();
  if (now - lastSyncAt < ATTENTION_CONFIG.sync.throttleMs) return;
  lastSyncAt = now;

  // Record fresh samples first so this pass's restart-rate / pressure reads
  // include the current poll.
  for (const node of snapshot.nodes) {
    const containers = snapshot.containersByNode.get(node.id) ?? [];
    if (!node.offline) {
      await recordRestartSamples(node.id, containers);
      const sys = node.systemInfo as Record<string, unknown> | null;
      const cpuPercent = typeof sys?.cpuPercent === "number" ? sys.cpuPercent : null;
      const memPercent = typeof sys?.memPercent === "number" ? sys.memPercent : null;
      const diskPercent = typeof sys?.diskPercent === "number" ? sys.diskPercent : null;
      await recordNodeResourceSample(node.id, { cpuPercent, memPercent, diskPercent });
    }
  }

  const [nodeConditions, containerConditions, operationConditions] = await Promise.all([
    deriveNodeConditions(snapshot.nodes),
    deriveContainerConditions(snapshot),
    deriveOperationConditions()
  ]);
  const workloadConditions = await deriveWorkloadConditions(snapshot, containerConditions);

  const preserveNodeIds = new Set(
    snapshot.nodes.filter((node) => node.isActive && !node.polledOnline && !node.offline).map((node) => node.id)
  );
  await syncAttentionState(
    [...nodeConditions, ...containerConditions, ...workloadConditions, ...operationConditions],
    preserveNodeIds
  );
  await pruneOldSamples().catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Reads: feed, per-resource severity, fleet summary, recent failures
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<AttentionSeverity, number> = { critical: 0, warning: 1, info: 2 };

function toAttentionItem(
  state: {
    id: string;
    resourceType: ResourceType;
    resourceId: string;
    conditionType: string;
    severity: string;
    title: string;
    detail: string;
    firstObservedAt: Date;
    lastObservedAt: Date;
    metadata: unknown;
    acknowledgements?: Array<{
      id: string;
      acknowledgedAt: Date;
      note: string | null;
      acknowledgedBy: { displayName: string; email: string } | null;
    }>;
  },
  role: "ADMIN" | "CLIENT",
  lifecycle?: LifecyclePolicyContext
): AttentionItem {
  const severity = state.severity.toLowerCase() as AttentionSeverity;
  const nodeId = state.resourceType === "NODE" ? state.resourceId : state.resourceType === "CONTAINER" ? state.resourceId.split(":")[0] : null;
  const meta = (state.metadata as Record<string, unknown>) ?? {};
  const acknowledgement = role === "ADMIN" ? state.acknowledgements?.[0] ?? null : null;
  const silence = lifecycle?.activeSilences[0] ?? null;
  const maintenance = lifecycle?.activeMaintenance[0] ?? null;
  return {
    id: state.id,
    severity,
    category: state.resourceType.toLowerCase(),
    conditionType: state.conditionType,
    title: state.title,
    detail: state.detail,
    resourceType: state.resourceType.toLowerCase() as AttentionItem["resourceType"],
    resourceId: state.resourceId,
    nodeId,
    href: href(state.resourceType, state.resourceId, role),
    firstObservedAt: state.firstObservedAt.toISOString(),
    lastObservedAt: state.lastObservedAt.toISOString(),
    affectedCount: typeof meta.affectedCount === "number" ? meta.affectedCount : undefined,
    ...(role === "ADMIN" ? {
      acknowledgement: acknowledgement ? {
        id: acknowledgement.id,
        acknowledgedBy: acknowledgement.acknowledgedBy?.displayName ?? acknowledgement.acknowledgedBy?.email ?? "Unknown administrator",
        acknowledgedAt: acknowledgement.acknowledgedAt.toISOString(),
        note: acknowledgement.note
      } : null,
      silence: silence ? {
        id: silence.id,
        endsAt: silence.endsAt.toISOString(),
        reason: silence.reason,
        createdBy: silence.createdBy?.displayName ?? silence.createdBy?.email ?? null
      } : null,
      maintenance: maintenance ? {
        id: maintenance.id,
        startsAt: maintenance.startsAt.toISOString(),
        endsAt: maintenance.endsAt.toISOString(),
        reason: maintenance.reason
      } : null
    } : {})
  };
}

/**
 * Admin-scoped "Needs attention" feed with deduplication (§4): when a node
 * is OFFLINE, per-container conditions on that node are suppressed (the
 * node card already states the affected count) — container/workload detail
 * pages still show their own local state independently.
 */
async function getDeduplicatedAdminAttentionRows() {
  const rows = await prisma.attentionState.findMany({
    where: { resolvedAt: null, severity: { in: ["CRITICAL", "WARNING"] } },
    orderBy: [{ severity: "asc" }, { lastObservedAt: "desc" }],
    include: {
      acknowledgements: {
        where: { clearedAt: null },
        orderBy: { acknowledgedAt: "desc" },
        take: 1,
        include: { acknowledgedBy: { select: { displayName: true, email: true } } }
      }
    }
  });

  const offlineNodeIds = new Set(
    rows.filter((r) => r.resourceType === "NODE" && r.conditionType === CONDITION.NODE_OFFLINE).map((r) => r.resourceId)
  );
  const workloadAffectedContainerKeys = new Set<string>();
  for (const row of rows) {
    if (row.resourceType !== "WORKLOAD") continue;
    const metadata = (row.metadata as Record<string, unknown> | null) ?? {};
    const keys = Array.isArray(metadata.affectedContainerKeys) ? metadata.affectedContainerKeys : [];
    for (const key of keys) if (typeof key === "string") workloadAffectedContainerKeys.add(key);
  }

  return rows.filter((r) => {
    if (r.resourceType === "NODE") return true;
    // Suppress container/workload items whose nodeId is offline — the node
    // card already communicates the blast radius.
    const meta = (r.metadata as Record<string, unknown> | null) ?? {};
    const nodeId = r.resourceType === "CONTAINER" ? r.resourceId.split(":")[0] : (meta.nodeId as string | undefined);
    if (nodeId && offlineNodeIds.has(nodeId)) return false;
    if (r.resourceType === "CONTAINER" && workloadAffectedContainerKeys.has(r.resourceId)) return false;
    return true;
  });
}

export async function getAttentionFeedForAdmin(): Promise<AttentionItem[]> {
  const filtered = await getDeduplicatedAdminAttentionRows();
  const lifecycle = await getLifecyclePolicyContexts(filtered);

  const items = filtered
    .sort((a, b) => {
      const sevDiff = SEVERITY_RANK[a.severity.toLowerCase() as AttentionSeverity] - SEVERITY_RANK[b.severity.toLowerCase() as AttentionSeverity];
      return b.lastObservedAt.getTime() - a.lastObservedAt.getTime();
    })
    .slice(0, ATTENTION_CONFIG.feed.maxItems)
    .map((r) => toAttentionItem(r, "ADMIN", lifecycle.get(r.id)));

  return items;
}

/** Client-scoped feed: only conditions on resources the client can see. */
export async function getAttentionFeedForClient(clientAccountId: string): Promise<AttentionItem[]> {
  const grantedProjectIds = await prisma.accessGrant.findMany({
    where: { clientAccountId, isActive: true, projectId: { not: null } },
    select: { projectId: true }
  });
  const ownProjects = await prisma.project.findMany({ where: { clientAccountId }, select: { id: true } });
  const workloadIds = new Set([
    ...grantedProjectIds.map((g) => g.projectId).filter((v): v is string => !!v),
    ...ownProjects.map((p) => p.id)
  ]);
  if (workloadIds.size === 0) return [];

  const rows = await prisma.attentionState.findMany({
    where: {
      resolvedAt: null,
      severity: { in: ["CRITICAL", "WARNING"] },
      resourceType: "WORKLOAD",
      resourceId: { in: Array.from(workloadIds) }
    },
    orderBy: [{ severity: "asc" }, { lastObservedAt: "desc" }]
  });
  return rows.slice(0, ATTENTION_CONFIG.feed.maxItems).map((r) => toAttentionItem(r, "CLIENT"));
}

/** Per-resource attention lookup (for badges on Workloads/Containers/Nodes lists). */
export async function getAttentionMap(): Promise<Map<string, AttentionSeverity>> {
  const rows = await prisma.attentionState.findMany({
    where: { resolvedAt: null },
    select: { resourceType: true, resourceId: true, severity: true }
  });
  const map = new Map<string, AttentionSeverity>();
  for (const r of rows) {
    const key = `${r.resourceType}:${r.resourceId}`;
    const sev = r.severity.toLowerCase() as AttentionSeverity;
    const existing = map.get(key);
    if (!existing || SEVERITY_RANK[sev] < SEVERITY_RANK[existing]) {
      map.set(key, sev);
    }
  }
  return map;
}

/** Roll a container's own attention up to its workload (any member's worst severity wins), plus workload-native conditions. */
export function worstOf(...severities: Array<AttentionSeverity | "healthy" | "unknown" | undefined>): AttentionSeverity | "healthy" | "unknown" {
  const rank: Record<string, number> = { critical: 0, warning: 1, info: 2, unknown: 3, healthy: 4 };
  let best: AttentionSeverity | "healthy" | "unknown" = "healthy";
  for (const s of severities) {
    if (!s) continue;
    if (rank[s] < rank[best]) best = s;
  }
  return best;
}

/** Recent failures (§13) — point-in-time, not part of the persisted condition model. */
export async function getRecentFailures(limit = ATTENTION_CONFIG.recentFailures.limit): Promise<RecentFailure[]> {
  const since = new Date(Date.now() - ATTENTION_CONFIG.recentFailures.windowMs);
  const [containerOps, deployOps] = await Promise.all([
    prisma.operation.findMany({
      where: { state: "FAILED", finishedAt: { gte: since } },
      orderBy: { finishedAt: "desc" },
      take: limit,
      include: { node: { select: { id: true, name: true } } }
    }),
    prisma.deploymentOperation.findMany({
      where: { state: "FAILED", finishedAt: { gte: since } },
      orderBy: { finishedAt: "desc" },
      take: limit,
      include: { deployment: { select: { projectId: true, project: { select: { name: true, nodeId: true } } } } }
    })
  ]);

  const failures: RecentFailure[] = [];
  for (const op of containerOps) {
    failures.push({
      id: op.id,
      kind: "operation",
      title: `${op.type.replace("CONTAINER_", "").toLowerCase()} failed on ${op.node.name}`,
      detail: op.error,
      resourceType: "operation",
      resourceId: op.id,
      href: `/admin/containers/${op.nodeId}/${op.dockerContainerId}`,
      createdAt: (op.finishedAt ?? op.requestedAt).toISOString()
    });
  }
  for (const op of deployOps) {
    failures.push({
      id: op.id,
      kind: "deployment",
      title: `${op.type.toLowerCase()} failed on ${op.deployment.project.name}`,
      detail: op.error,
      resourceType: "workload",
      resourceId: op.deployment.projectId,
      href: `/admin/workloads/${op.deployment.projectId}`,
      createdAt: (op.finishedAt ?? op.requestedAt).toISOString()
    });
  }

  return failures.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}

/** Active (in-flight) operations for the Overview "Active operations" section (§12). */
export async function getActiveOperations(): Promise<ActiveOperationSummary[]> {
  const [containerOps, deployOps] = await Promise.all([
    prisma.operation.findMany({
      where: { state: { in: ["REQUESTED", "QUEUED", "RUNNING"] } },
      orderBy: { requestedAt: "desc" },
      take: 20,
      include: { node: { select: { id: true, name: true } } }
    }),
    prisma.deploymentOperation.findMany({
      where: { state: { in: ["REQUESTED", "QUEUED", "RUNNING"] } },
      orderBy: { requestedAt: "desc" },
      take: 20,
      include: { deployment: { select: { projectId: true, project: { select: { name: true } } } } }
    })
  ]);

  const active: ActiveOperationSummary[] = [];
  for (const op of containerOps) {
    active.push({
      id: op.id,
      kind: "container",
      type: op.type,
      state: op.state,
      targetName: `${op.dockerContainerId.slice(0, 12)} on ${op.node.name}`,
      targetHref: `/admin/containers/${op.nodeId}/${op.dockerContainerId}`,
      actorEmail: op.actorEmail,
      startedAt: op.startedAt?.toISOString() ?? null,
      requestedAt: op.requestedAt.toISOString()
    });
  }
  for (const op of deployOps) {
    active.push({
      id: op.id,
      kind: "deployment",
      type: op.type,
      state: op.state,
      targetName: op.deployment.project.name,
      targetHref: `/admin/workloads/${op.deployment.projectId}`,
      actorEmail: op.actorEmail,
      startedAt: op.startedAt?.toISOString() ?? null,
      requestedAt: op.requestedAt.toISOString()
    });
  }
  return active.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
}

/** Fleet summary counters (§2). */
export async function getFleetSummary(
  snapshot: OverviewSnapshot,
  workloadHealthCounts: { healthy: number; total: number; degraded: number }
): Promise<FleetSummary> {
  const totals = { containersRunning: 0, containersTotal: 0, unhealthy: 0 };
  for (const containers of snapshot.containersByNode.values()) {
    totals.containersTotal += containers.length;
    totals.containersRunning += containers.filter((c) => c.status === "running").length;
    totals.unhealthy += containers.filter((c) => c.health === "unhealthy" || c.status === "unhealthy").length;
  }
  const activeNodes = snapshot.nodes.filter((n) => n.isActive);
  const nodesOnline = activeNodes.filter((n) => n.heartbeatState !== "OFFLINE").length;

  const [attentionCount, activeOps] = await Promise.all([
    getDeduplicatedAdminAttentionRows().then((rows) => rows.length),
    Promise.all([
      prisma.operation.count({ where: { state: { in: ["REQUESTED", "QUEUED", "RUNNING"] } } }),
      prisma.deploymentOperation.count({ where: { state: { in: ["REQUESTED", "QUEUED", "RUNNING"] } } })
    ]).then(([a, b]) => a + b)
  ]);

  return {
    nodesOnline,
    nodesTotal: activeNodes.length,
    workloadsHealthy: workloadHealthCounts.healthy,
    workloadsTotal: workloadHealthCounts.total,
    containersRunning: totals.containersRunning,
    containersTotal: totals.containersTotal,
    unhealthyContainers: totals.unhealthy,
    activeOperations: activeOps,
    degradedWorkloads: workloadHealthCounts.degraded,
    attentionIssues: attentionCount
  };
}

function timeAgo(date: Date): string {
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
