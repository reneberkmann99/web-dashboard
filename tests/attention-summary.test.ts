import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "./helpers/db";
import { resetDatabase } from "./setup";
import { seedWorld } from "./helpers/fixtures";
import { getFleetSummary, getRecentFailures, getActiveOperations } from "@/server/services/attention";
import type { OverviewSnapshot, NodeOperationalView } from "@/server/services/overview";
import type { RuntimeContainer } from "@/server/services/node-agent/types";
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
    hostname: "host.test",
    status: overrides.status ?? "ONLINE",
    isActive: overrides.isActive ?? true,
    lastHeartbeatAt: new Date(),
    heartbeatState: overrides.heartbeatState ?? "ONLINE",
    agentVersion: "0.3.0",
    dockerVersion: "29.0.0",
    systemInfo: null,
    containerCount: overrides.containerCount ?? 0,
    runningCount: overrides.runningCount ?? 0,
    polledOnline: true,
    offline: overrides.offline ?? false,
    staleHeartbeat: false
  };
}

function container(id: string, status: RuntimeContainer["status"] = "running"): RuntimeContainer {
  return {
    id,
    name: id,
    image: "nginx",
    status,
    uptime: "1h",
    ports: "-",
    createdAt: new Date().toISOString(),
    cpuPercent: 1,
    memoryUsage: "10MiB / 1GiB",
    restartCount: 0,
    restartPolicy: "unless-stopped",
    lastUpdatedAt: new Date().toISOString()
  };
}

describe("fleet summary", () => {
  it("counts nodes/containers/workloads consistently with the snapshot", async () => {
    const snapshot: OverviewSnapshot = {
      nodes: [nodeView({ id: world.node1.id, name: world.node1.name, containerCount: 2, runningCount: 1 })],
      containersByNode: new Map([[world.node1.id, [container("c1", "running"), container("c2", "unhealthy")]]])
    };
    const summary = await getFleetSummary(snapshot, { healthy: 3, total: 5, degraded: 2 });
    expect(summary.containersTotal).toBe(2);
    expect(summary.containersRunning).toBe(1);
    expect(summary.unhealthyContainers).toBe(1);
    expect(summary.workloadsHealthy).toBe(3);
    expect(summary.workloadsTotal).toBe(5);
    expect(summary.degradedWorkloads).toBe(2);
    expect(summary.nodesOnline).toBe(1);
    expect(summary.nodesTotal).toBe(1);
  });

  it("nodesOnline excludes an offline node from the online count but keeps it in total", async () => {
    const snapshot: OverviewSnapshot = {
      nodes: [
        nodeView({ id: world.node1.id, name: world.node1.name }),
        nodeView({ id: world.node2.id, name: world.node2.name, offline: true, heartbeatState: "OFFLINE" })
      ],
      containersByNode: new Map()
    };
    const summary = await getFleetSummary(snapshot, { healthy: 0, total: 0, degraded: 0 });
    expect(summary.nodesTotal).toBe(2);
    expect(summary.nodesOnline).toBe(1);
  });
});

describe("recent failures", () => {
  it("includes a recently failed container operation with a direct href", async () => {
    const suffix = `${Date.now()}`;
    const op = await prisma.operation.create({
      data: {
        type: "CONTAINER_RESTART",
        state: "FAILED",
        requestId: `fail-${suffix}`,
        nodeId: world.node1.id,
        dockerContainerId: `failing-container-${suffix}`,
        error: "agent rejected the action",
        finishedAt: new Date()
      }
    });
    const failures = await getRecentFailures();
    const found = failures.find((f) => f.resourceId === op.id);
    expect(found).toBeDefined();
    expect(found?.href).toContain(world.node1.id);
    expect(found?.detail).toContain("agent rejected");
  });

  it("includes a recently failed deployment operation", async () => {
    const suffix = `${Date.now()}`;
    const project = await prisma.project.create({
      data: { name: `Fail Deploy ${suffix}`, slug: `fail-deploy-${suffix}`, nodeId: world.node1.id, source: ProjectSource.COMPOSE, composeProject: `fail-deploy-${suffix}`, isActive: true }
    });
    const deployment = await prisma.deployment.create({
      data: { projectId: project.id, source: DeploymentSource.HOSTPANEL, composeProjectName: `fail-deploy-${suffix}` }
    });
    const op = await prisma.deploymentOperation.create({
      data: { type: "DEPLOY", state: "FAILED", requestId: `fail-deploy-${suffix}`, deploymentId: deployment.id, error: "apply failed", finishedAt: new Date() }
    });
    const failures = await getRecentFailures();
    const found = failures.find((f) => f.resourceId === project.id);
    expect(found).toBeDefined();
    expect(found?.href).toBe(`/admin/workloads/${project.id}`);
  });
});

describe("active operations", () => {
  it("lists an in-flight container operation with a direct link to the container", async () => {
    const suffix = `${Date.now()}`;
    const op = await prisma.operation.create({
      data: {
        type: "CONTAINER_START",
        state: "RUNNING",
        requestId: `active-${suffix}`,
        nodeId: world.node1.id,
        dockerContainerId: `active-container-${suffix}`
      }
    });
    const active = await getActiveOperations();
    const found = active.find((a) => a.id === op.id);
    expect(found).toBeDefined();
    expect(found?.kind).toBe("container");
    expect(found?.targetHref).toContain(world.node1.id);
  });

  it("does not list a terminal (SUCCEEDED) operation as active", async () => {
    const suffix = `${Date.now()}`;
    const op = await prisma.operation.create({
      data: {
        type: "CONTAINER_STOP",
        state: "SUCCEEDED",
        requestId: `done-${suffix}`,
        nodeId: world.node1.id,
        dockerContainerId: `done-container-${suffix}`,
        finishedAt: new Date()
      }
    });
    const active = await getActiveOperations();
    expect(active.some((a) => a.id === op.id)).toBe(false);
  });
});
