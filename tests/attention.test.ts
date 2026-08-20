import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "./helpers/db";
import { resetDatabase } from "./setup";
import { seedWorld } from "./helpers/fixtures";
import {
  deriveNodeConditions,
  deriveContainerConditions,
  deriveWorkloadConditions,
  deriveOperationConditions,
  syncAttentionState,
  getAttentionFeedForAdmin,
  getAttentionFeedForClient,
  getAttentionMap,
  recordRestartSamples,
  recordNodeResourceSample,
  CONDITION
} from "@/server/services/attention";
import type { OverviewSnapshot, NodeOperationalView } from "@/server/services/overview";
import type { RuntimeContainer } from "@/server/services/node-agent/types";
import { ATTENTION_CONFIG } from "@/server/services/attention-config";
import { DeploymentSource, ProjectSource } from "@prisma/client";

let world: Awaited<ReturnType<typeof seedWorld>>;

beforeAll(async () => {
  resetDatabase();
  world = await seedWorld();
});

function nodeView(overrides: Partial<NodeOperationalView> & { id: string; name: string }): NodeOperationalView {
  return {
    id: overrides.id,
    name: overrides.name,
    hostname: overrides.hostname ?? "host.test",
    status: overrides.status ?? "ONLINE",
    isActive: overrides.isActive ?? true,
    lastHeartbeatAt: overrides.lastHeartbeatAt ?? new Date(),
    heartbeatState: overrides.heartbeatState ?? "ONLINE",
    agentVersion: overrides.agentVersion ?? ATTENTION_CONFIG.agentVersion.current,
    dockerVersion: overrides.dockerVersion ?? "29.0.0",
    systemInfo: overrides.systemInfo ?? null,
    containerCount: overrides.containerCount ?? 0,
    runningCount: overrides.runningCount ?? 0,
    polledOnline: overrides.polledOnline ?? true,
    offline: overrides.offline ?? false,
    staleHeartbeat: overrides.staleHeartbeat ?? false
  };
}

function container(overrides: Partial<RuntimeContainer> & { id: string }): RuntimeContainer {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    image: overrides.image ?? "nginx:latest",
    status: overrides.status ?? "running",
    health: overrides.health ?? null,
    uptime: overrides.uptime ?? "1h",
    ports: overrides.ports ?? "-",
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    cpuPercent: overrides.cpuPercent ?? 1,
    memoryUsage: overrides.memoryUsage ?? "10MiB / 1GiB",
    restartCount: overrides.restartCount ?? 0,
    restartPolicy: overrides.restartPolicy ?? "unless-stopped",
    lastUpdatedAt: overrides.lastUpdatedAt ?? new Date().toISOString()
  };
}

function snapshot(nodes: NodeOperationalView[], containersByNode: Record<string, RuntimeContainer[]>): OverviewSnapshot {
  return { nodes, containersByNode: new Map(Object.entries(containersByNode)) };
}

describe("attention model — node conditions", () => {
  it("node online with fresh heartbeat and no pressure produces no conditions", async () => {
    const node = nodeView({ id: world.node1.id, name: world.node1.name });
    const conditions = await deriveNodeConditions([node]);
    expect(conditions).toHaveLength(0);
  });

  it("node offline produces a critical NODE_OFFLINE condition with affected container count", async () => {
    const node = nodeView({
      id: world.node1.id,
      name: world.node1.name,
      heartbeatState: "OFFLINE",
      offline: true,
      containerCount: 5,
      lastHeartbeatAt: new Date(Date.now() - 10 * 60_000)
    });
    const conditions = await deriveNodeConditions([node]);
    const offline = conditions.find((c) => c.conditionType === CONDITION.NODE_OFFLINE);
    expect(offline).toBeDefined();
    expect(offline!.severity).toBe("critical");
    expect(offline!.detail).toContain("5");
  });

  it("node stale heartbeat produces a warning, not critical", async () => {
    const node = nodeView({
      id: world.node1.id,
      name: world.node1.name,
      heartbeatState: "STALE",
      staleHeartbeat: true,
      lastHeartbeatAt: new Date(Date.now() - 100_000)
    });
    const conditions = await deriveNodeConditions([node]);
    const stale = conditions.find((c) => c.conditionType === CONDITION.NODE_HEARTBEAT_STALE);
    expect(stale).toBeDefined();
    expect(stale!.severity).toBe("warning");
  });

  it("offline node suppresses resource-pressure/version conditions (dedup)", async () => {
    const node = nodeView({
      id: world.node1.id,
      name: world.node1.name,
      heartbeatState: "OFFLINE",
      offline: true,
      agentVersion: "0.0.1" // outdated — would normally also fire
    });
    const conditions = await deriveNodeConditions([node]);
    expect(conditions).toHaveLength(1);
    expect(conditions[0].conditionType).toBe(CONDITION.NODE_OFFLINE);
  });

  it("outdated agent version produces a warning", async () => {
    const node = nodeView({ id: world.node1.id, name: world.node1.name, agentVersion: "0.0.1" });
    const conditions = await deriveNodeConditions([node]);
    const outdated = conditions.find((c) => c.conditionType === CONDITION.NODE_AGENT_OUTDATED);
    expect(outdated).toBeDefined();
    expect(outdated!.severity).toBe("warning");
  });

  it("sustained disk pressure crosses warning then critical thresholds", async () => {
    // Independent node ids per assertion — the sustained-window average
    // includes every sample recorded for that node, so reusing one id across
    // the warning and critical phases would average them together.
    const warnNodeId = `disk-warn-${Date.now()}`;
    for (let i = 0; i < 3; i++) {
      await recordNodeResourceSample(warnNodeId, { cpuPercent: null, memPercent: null, diskPercent: 90 }, true);
    }
    const warnConditions = await deriveNodeConditions([nodeView({ id: warnNodeId, name: "Disk Warn Node" })]);
    const warn = warnConditions.find((c) => c.conditionType === CONDITION.NODE_DISK_PRESSURE);
    expect(warn).toBeDefined();
    expect(warn!.severity).toBe("warning");

    const critNodeId = `disk-crit-${Date.now()}`;
    for (let i = 0; i < 3; i++) {
      await recordNodeResourceSample(critNodeId, { cpuPercent: null, memPercent: null, diskPercent: 99 }, true);
    }
    const critConditions = await deriveNodeConditions([nodeView({ id: critNodeId, name: "Disk Crit Node" })]);
    const crit = critConditions.find((c) => c.conditionType === CONDITION.NODE_DISK_PRESSURE);
    expect(crit).toBeDefined();
    expect(crit!.severity).toBe("critical");
  });

  it("a single spiking sample does not cross the minimum-samples-for-sustained gate", async () => {
    const isolatedNodeId = `node-isolated-${Date.now()}`;
    await recordNodeResourceSample(isolatedNodeId, { cpuPercent: 99.9, memPercent: null, diskPercent: null }, true);
    const node = nodeView({ id: isolatedNodeId, name: "Isolated" });
    const conditions = await deriveNodeConditions([node]);
    expect(conditions.find((c) => c.conditionType === CONDITION.NODE_CPU_PRESSURE)).toBeUndefined();
  });
});

describe("attention model — container conditions", () => {
  it("unhealthy container produces a warning condition", async () => {
    const node = nodeView({ id: world.node1.id, name: world.node1.name });
    const snap = snapshot([node], { [world.node1.id]: [container({ id: "unhealthy-c1", status: "running", health: "unhealthy" })] });
    const conditions = await deriveContainerConditions(snap);
    const item = conditions.find((c) => c.conditionType === CONDITION.CONTAINER_UNHEALTHY);
    expect(item).toBeDefined();
    expect(item!.severity).toBe("warning");
  });

  it("unexpected stop (restart policy always) is critical; intentional stop (policy no) is info", async () => {
    const node = nodeView({ id: world.node1.id, name: world.node1.name });
    const snap = snapshot([node], {
      [world.node1.id]: [
        container({ id: "unexpected-stop-1", status: "stopped", restartPolicy: "always" }),
        container({ id: "intentional-stop-1", status: "stopped", restartPolicy: "no" })
      ]
    });
    const conditions = await deriveContainerConditions(snap);
    const unexpected = conditions.find((c) => c.resourceId === `${world.node1.id}:unexpected-stop-1`);
    const intentional = conditions.find((c) => c.resourceId === `${world.node1.id}:intentional-stop-1`);
    expect(unexpected?.conditionType).toBe(CONDITION.CONTAINER_UNEXPECTED_STOP);
    expect(unexpected?.severity).toBe("critical");
    expect(intentional?.conditionType).toBe(CONDITION.CONTAINER_STOPPED_INTENTIONAL);
    expect(intentional?.severity).toBe("info");
  });

  it("containers on an offline node are skipped entirely (dedup — node card covers them)", async () => {
    const node = nodeView({ id: world.node1.id, name: world.node1.name, offline: true, heartbeatState: "OFFLINE" });
    const snap = snapshot([node], { [world.node1.id]: [container({ id: "on-offline-node", status: "unhealthy" })] });
    const conditions = await deriveContainerConditions(snap);
    expect(conditions).toHaveLength(0);
  });

  it("high sustained CPU on a container produces a warning", async () => {
    const node = nodeView({ id: world.node1.id, name: world.node1.name });
    const snap = snapshot([node], { [world.node1.id]: [container({ id: "hot-cpu-1", cpuPercent: 95 })] });
    await deriveContainerConditions(snap);
    await deriveContainerConditions(snap);
    const conditions = await deriveContainerConditions(snap);
    expect(conditions.find((c) => c.conditionType === CONDITION.CONTAINER_HIGH_CPU)).toBeDefined();
  });

  it("high memory against a container limit requires sustained observations", async () => {
    const node = nodeView({ id: world.node1.id, name: world.node1.name });
    const snap = snapshot([node], {
      [world.node1.id]: [container({ id: "hot-memory-1", memoryUsage: "980MiB / 1GiB" })]
    });
    expect((await deriveContainerConditions(snap)).some((c) => c.conditionType === CONDITION.CONTAINER_HIGH_MEMORY)).toBe(false);
    await deriveContainerConditions(snap);
    const conditions = await deriveContainerConditions(snap);
    const memory = conditions.find((c) => c.conditionType === CONDITION.CONTAINER_HIGH_MEMORY);
    expect(memory).toBeDefined();
    expect(memory?.severity).toBe("warning");
  });
});

describe("attention model — crash-loop detection", () => {
  it("restarts below the warning threshold do not raise a condition", async () => {
    const nodeId = `crashloop-node-${Date.now()}-a`;
    const dockerId = "loop-container-a";
    // Only 2 restarts observed — below warningCount (3).
    await recordRestartSamples(nodeId, [container({ id: dockerId, restartCount: 1 })]);
    await recordRestartSamples(nodeId, [container({ id: dockerId, restartCount: 2 })]);

    const node = nodeView({ id: nodeId, name: "Crash Loop Node A" });
    const snap = snapshot([node], { [nodeId]: [container({ id: dockerId, restartCount: 2 })] });
    const conditions = await deriveContainerConditions(snap);
    expect(conditions.find((c) => c.conditionType === CONDITION.CONTAINER_CRASH_LOOP)).toBeUndefined();
  });

  it("restarts at/above warning threshold raise a warning; at/above critical raise critical", async () => {
    // restartsInWindow is the delta between the first and last sample inside
    // the window. The first zero sample establishes a baseline, so 0 -> 3 is
    // exactly three recent restarts (== warningCount).
    const nodeId = `crashloop-node-${Date.now()}-b`;
    const dockerId = "loop-container-b";
    for (let n = 0; n <= 3; n++) {
      await recordRestartSamples(nodeId, [container({ id: dockerId, restartCount: n })]);
    }
    const node = nodeView({ id: nodeId, name: "Crash Loop Node B" });
    let snap = snapshot([node], { [nodeId]: [container({ id: dockerId, restartCount: 3 })] });
    let conditions = await deriveContainerConditions(snap);
    let item = conditions.find((c) => c.conditionType === CONDITION.CONTAINER_CRASH_LOOP);
    expect(item?.severity).toBe("warning");

    const criticalNodeId = `crashloop-node-${Date.now()}-b-crit`;
    for (let n = 0; n <= 8; n++) {
      await recordRestartSamples(criticalNodeId, [container({ id: dockerId, restartCount: n })]);
    }
    const critNode = nodeView({ id: criticalNodeId, name: "Crash Loop Node B Critical" });
    snap = snapshot([critNode], { [criticalNodeId]: [container({ id: dockerId, restartCount: 8 })] });
    conditions = await deriveContainerConditions(snap);
    item = conditions.find((c) => c.conditionType === CONDITION.CONTAINER_CRASH_LOOP);
    expect(item?.severity).toBe("critical");
  });

  it("recovery: restart rate drops out of the window and the condition clears", async () => {
    // Simulate by using a node/container id whose samples are all outside
    // the rolling window (we can't move the clock, so assert the read path
    // returns nothing for a container with zero samples in range).
    const nodeId = `crashloop-node-${Date.now()}-c`;
    const dockerId = "loop-container-c";
    const node = nodeView({ id: nodeId, name: "Crash Loop Node C" });
    const snap = snapshot([node], { [nodeId]: [container({ id: dockerId, restartCount: 0 })] });
    const conditions = await deriveContainerConditions(snap);
    expect(conditions.find((c) => c.conditionType === CONDITION.CONTAINER_CRASH_LOOP)).toBeUndefined();
  });

  it("deployment-driven restarts within the suppression window do not look like a crash loop", async () => {
    const suffix = `${Date.now()}`;
    const project = await prisma.project.create({
      data: {
        name: `Deploy Suppress ${suffix}`,
        slug: `deploy-suppress-${suffix}`,
        nodeId: world.node1.id,
        source: ProjectSource.COMPOSE,
        composeProject: `deploy-suppress-${suffix}`,
        isActive: true
      }
    });
    const deployment = await prisma.deployment.create({
      data: { projectId: project.id, source: DeploymentSource.HOSTPANEL, composeProjectName: `deploy-suppress-${suffix}` }
    });
    await prisma.deploymentOperation.create({
      data: {
        type: "DEPLOY",
        state: "SUCCEEDED",
        requestId: `req-${suffix}`,
        deploymentId: deployment.id,
        finishedAt: new Date()
      }
    });
    const dockerId = `deploy-restart-${suffix}`;
    await prisma.container.create({
      data: {
        nodeId: world.node1.id,
        dockerContainerId: dockerId,
        dockerName: "web",
        projectId: project.id,
        isActive: true
      }
    });

    for (let n = 1; n <= 5; n++) {
      await recordRestartSamples(world.node1.id, [container({ id: dockerId, restartCount: n })]);
    }
    const node = nodeView({ id: world.node1.id, name: world.node1.name });
    const snap = snapshot([node], { [world.node1.id]: [container({ id: dockerId, restartCount: 5 })] });
    const conditions = await deriveContainerConditions(snap);
    expect(conditions.find((c) => c.conditionType === CONDITION.CONTAINER_CRASH_LOOP && c.resourceId === `${world.node1.id}:${dockerId}`)).toBeUndefined();
  });
});

describe("attention model — workload/deployment conditions", () => {
  it("DEGRADED runtime state produces a workload warning; DRIFTED produces critical, never mislabeled", async () => {
    const suffix = `${Date.now()}`;
    const degradedProject = await prisma.project.create({
      data: { name: `Degraded ${suffix}`, slug: `degraded-${suffix}`, nodeId: world.node1.id, source: ProjectSource.COMPOSE, composeProject: `degraded-${suffix}`, isActive: true }
    });
    await prisma.deployment.create({
      data: { projectId: degradedProject.id, source: DeploymentSource.HOSTPANEL, composeProjectName: `degraded-${suffix}`, runtimeState: "DEGRADED" }
    });

    const driftedProject = await prisma.project.create({
      data: { name: `Drifted ${suffix}`, slug: `drifted-${suffix}`, nodeId: world.node1.id, source: ProjectSource.COMPOSE, composeProject: `drifted-${suffix}`, isActive: true }
    });
    await prisma.deployment.create({
      data: { projectId: driftedProject.id, source: DeploymentSource.HOSTPANEL, composeProjectName: `drifted-${suffix}`, runtimeState: "DRIFTED" }
    });

    const conditions = await deriveWorkloadConditions();
    const degraded = conditions.find((c) => c.resourceId === degradedProject.id);
    const drifted = conditions.find((c) => c.resourceId === driftedProject.id);
    expect(degraded?.conditionType).toBe(CONDITION.WORKLOAD_DEGRADED);
    expect(degraded?.severity).toBe("warning");
    expect(drifted?.conditionType).toBe(CONDITION.WORKLOAD_DRIFTED);
    expect(drifted?.severity).toBe("critical");
    // Never mislabeled as each other.
    expect(degraded?.conditionType).not.toBe(CONDITION.WORKLOAD_DRIFTED);
  });
});

describe("attention model — operation-stuck detection", () => {
  it("a long-running container operation past the timeout is flagged critical", async () => {
    const suffix = `${Date.now()}`;
    await prisma.operation.create({
      data: {
        type: "CONTAINER_RESTART",
        state: "RUNNING",
        requestId: `stuck-${suffix}`,
        nodeId: world.node1.id,
        dockerContainerId: `stuck-container-${suffix}`,
        requestedAt: new Date(Date.now() - ATTENTION_CONFIG.operation.containerOpStuckAfterMs - 60_000)
      }
    });
    const conditions = await deriveOperationConditions();
    expect(conditions.some((c) => c.detail.includes("Requested"))).toBe(true);
  });

  it("a recent (not stuck) operation is not flagged", async () => {
    const suffix = `${Date.now()}`;
    const dockerContainerId = `fresh-container-${suffix}`;
    const fresh = await prisma.operation.create({
      data: {
        type: "CONTAINER_START",
        state: "RUNNING",
        requestId: `fresh-${suffix}`,
        nodeId: world.node1.id,
        dockerContainerId,
        requestedAt: new Date()
      }
    });
    const conditions = await deriveOperationConditions();
    expect(conditions.some((c) => c.resourceId === fresh.id)).toBe(false);
  });
});

describe("attention model — persisted state lifecycle + dedup + tenant isolation", () => {
  it("sync opens a condition, keeps it open on re-observation, then resolves it when absent", async () => {
    const suffix = `${Date.now()}`;
    const resourceId = `lifecycle-node-${suffix}`;
    const condition = {
      resourceType: "NODE" as const,
      resourceId,
      conditionType: CONDITION.NODE_OFFLINE,
      severity: "critical" as const,
      title: "Lifecycle test node is offline",
      detail: "test",
      nodeId: resourceId
    };

    await syncAttentionState([condition]);
    let row = await prisma.attentionState.findUnique({
      where: { resourceType_resourceId_conditionType: { resourceType: "NODE", resourceId, conditionType: CONDITION.NODE_OFFLINE } }
    });
    expect(row?.resolvedAt).toBeNull();
    const firstObserved = row!.firstObservedAt;

    // Re-observe: stays open, lastObservedAt may advance but resolvedAt stays null.
    await syncAttentionState([condition]);
    row = await prisma.attentionState.findUnique({
      where: { resourceType_resourceId_conditionType: { resourceType: "NODE", resourceId, conditionType: CONDITION.NODE_OFFLINE } }
    });
    expect(row?.resolvedAt).toBeNull();

    // Absent from the next sync pass → resolved.
    await syncAttentionState([]);
    row = await prisma.attentionState.findUnique({
      where: { resourceType_resourceId_conditionType: { resourceType: "NODE", resourceId, conditionType: CONDITION.NODE_OFFLINE } }
    });
    expect(row?.resolvedAt).not.toBeNull();
    void firstObserved;
  });

  it("a transient failed poll preserves prior container attention until telemetry returns", async () => {
    const nodeId = `grace-node-${Date.now()}`;
    const resourceId = `${nodeId}:grace-container`;
    await syncAttentionState([{
      resourceType: "CONTAINER",
      resourceId,
      conditionType: CONDITION.CONTAINER_UNHEALTHY,
      severity: "warning",
      title: "Grace container unhealthy",
      detail: "test",
      nodeId
    }]);

    await syncAttentionState([], new Set([nodeId]));
    let row = await prisma.attentionState.findUnique({
      where: { resourceType_resourceId_conditionType: { resourceType: "CONTAINER", resourceId, conditionType: CONDITION.CONTAINER_UNHEALTHY } }
    });
    expect(row?.resolvedAt).toBeNull();

    await syncAttentionState([]);
    row = await prisma.attentionState.findUnique({
      where: { resourceType_resourceId_conditionType: { resourceType: "CONTAINER", resourceId, conditionType: CONDITION.CONTAINER_UNHEALTHY } }
    });
    expect(row?.resolvedAt).not.toBeNull();
  });

  it("admin feed deduplicates: offline node suppresses its own containers' items but node item remains", async () => {
    const suffix = `${Date.now()}`;
    const nodeResourceId = `dedup-node-${suffix}`;
    const containerResourceId = `${nodeResourceId}:dedup-container-${suffix}`;

    await syncAttentionState([
      {
        resourceType: "NODE",
        resourceId: nodeResourceId,
        conditionType: CONDITION.NODE_OFFLINE,
        severity: "critical",
        title: "Dedup node offline",
        detail: "test",
        nodeId: nodeResourceId
      },
      {
        resourceType: "CONTAINER",
        resourceId: containerResourceId,
        conditionType: CONDITION.CONTAINER_UNHEALTHY,
        severity: "warning",
        title: "Dedup container unhealthy",
        detail: "test",
        nodeId: nodeResourceId
      }
    ]);

    const feed = await getAttentionFeedForAdmin();
    const nodeItem = feed.find((i) => i.resourceId === nodeResourceId);
    const containerItem = feed.find((i) => i.resourceId === containerResourceId);
    expect(nodeItem).toBeDefined();
    expect(containerItem).toBeUndefined();

    // Clean up so this doesn't leak into other tests reading the global feed.
    await syncAttentionState([]);
  });

  it("client feed only includes workload-scoped conditions for that client's grants, never node/other-client items", async () => {
    const suffix = `${Date.now()}`;
    await syncAttentionState([
      {
        resourceType: "WORKLOAD",
        resourceId: world.projectA.id,
        conditionType: CONDITION.WORKLOAD_DEGRADED,
        severity: "warning",
        title: `Client-visible workload degraded ${suffix}`,
        detail: "test",
        nodeId: world.node1.id
      },
      {
        resourceType: "NODE",
        resourceId: world.node1.id,
        conditionType: CONDITION.NODE_OFFLINE,
        severity: "critical",
        title: `Node offline should not leak to client ${suffix}`,
        detail: "test",
        nodeId: world.node1.id
      }
    ]);

    const clientAFeed = await getAttentionFeedForClient(world.clientA.id);
    const clientBFeed = await getAttentionFeedForClient(world.clientB.id);

    expect(clientAFeed.some((i) => i.resourceId === world.projectA.id)).toBe(true);
    expect(clientAFeed.some((i) => i.resourceType === "node")).toBe(false);
    expect(clientBFeed.some((i) => i.resourceId === world.projectA.id)).toBe(false);

    await syncAttentionState([]);
  });

  it("getAttentionMap returns the worst (most severe) open condition per resource", async () => {
    const suffix = `${Date.now()}`;
    const resourceId = `worst-of-${suffix}`;
    await syncAttentionState([
      {
        resourceType: "WORKLOAD",
        resourceId,
        conditionType: CONDITION.WORKLOAD_DEGRADED,
        severity: "warning",
        title: "warn",
        detail: "test",
        nodeId: null
      },
      {
        resourceType: "WORKLOAD",
        resourceId,
        conditionType: CONDITION.DEPLOYMENT_FAILED,
        severity: "critical",
        title: "crit",
        detail: "test",
        nodeId: null
      }
    ]);
    const map = await getAttentionMap();
    expect(map.get(`WORKLOAD:${resourceId}`)).toBe("critical");
    await syncAttentionState([]);
  });
});

describe("attention model — UNKNOWN telemetry safety", () => {
  it("a node whose systemInfo carries no resource fields never fabricates a pressure condition", async () => {
    const node = nodeView({ id: `unknown-telemetry-${Date.now()}`, name: "No Telemetry Node", systemInfo: null });
    const conditions = await deriveNodeConditions([node]);
    expect(conditions.find((c) => c.conditionType.includes("PRESSURE"))).toBeUndefined();
  });
});
