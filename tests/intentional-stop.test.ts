import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "./helpers/db";
import { resetDatabase } from "./setup";
import { seedWorld } from "./helpers/fixtures";
import {
  deriveContainerConditions,
  getExpectedStates,
  isExpectedRunning,
  CONDITION
} from "@/server/services/attention";
import { toWorkloadDetail } from "@/server/services/workloads";
import type { OverviewSnapshot, NodeOperationalView } from "@/server/services/overview";
import type { RuntimeContainer } from "@/server/services/node-agent/types";

let world: Awaited<ReturnType<typeof seedWorld>>;

beforeAll(async () => {
  resetDatabase();
  world = await seedWorld();
});

function nodeView(id: string, name: string): NodeOperationalView {
  return {
    id,
    name,
    hostname: "host.test",
    status: "ONLINE",
    isActive: true,
    lastHeartbeatAt: new Date(),
    heartbeatState: "ONLINE",
    agentVersion: "1.4.2",
    dockerVersion: "29.0.0",
    systemInfo: null,
    containerCount: 1,
    runningCount: 1,
    polledOnline: true,
    offline: false,
    staleHeartbeat: false
  };
}

function container(overrides: Partial<RuntimeContainer> & { id: string }): RuntimeContainer {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    image: "nginx:latest",
    status: overrides.status ?? "running",
    health: overrides.health ?? null,
    uptime: "1h",
    ports: "-",
    createdAt: new Date().toISOString(),
    cpuPercent: overrides.cpuPercent ?? 1,
    memoryUsage: "10MiB / 1GiB",
    restartCount: 0,
    restartPolicy: overrides.restartPolicy ?? "unless-stopped",
    lastUpdatedAt: new Date().toISOString()
  };
}

function snapshot(nodes: NodeOperationalView[], containersByNode: Record<string, RuntimeContainer[]>): OverviewSnapshot {
  return { nodes, containersByNode: new Map(Object.entries(containersByNode)) };
}

describe("isExpectedRunning", () => {
  it("explicit STOPPED overrides an always restart policy", () => {
    expect(isExpectedRunning("always", "STOPPED")).toBe(false);
  });

  it("explicit RUNNING overrides a no restart policy", () => {
    expect(isExpectedRunning("no", "RUNNING")).toBe(true);
  });

  it("falls back to restart policy when intent is unspecified", () => {
    expect(isExpectedRunning("always", undefined)).toBe(true);
    expect(isExpectedRunning("unless-stopped", null)).toBe(true);
    expect(isExpectedRunning("no", undefined)).toBe(false);
    expect(isExpectedRunning(null, undefined)).toBe(false);
  });
});

describe("intentional-stop semantics", () => {
  it("a stopped container with explicit operator intent raises NO attention (behaving as requested)", async () => {
    // Mark world.web (restartPolicy always, stopped) as intentionally stopped.
    await prisma.container.update({
      where: { id: world.web.id },
      data: { expectedState: "STOPPED" }
    });

    const node = nodeView(world.node1.id, world.node1.name);
    const snap = snapshot([node], {
      [world.node1.id]: [
        container({ id: world.web.dockerContainerId, status: "stopped", restartPolicy: "always" })
      ]
    });

    const conditions = await deriveContainerConditions(snap);
    // No unexpected-stop, no unhealthy, no intentional-stop condition.
    expect(conditions).toHaveLength(0);
  });

  it("an intentionally stopped container that Docker still reports unhealthy raises nothing", async () => {
    await prisma.container.update({
      where: { id: world.web.id },
      data: { expectedState: "STOPPED" }
    });

    const node = nodeView(world.node1.id, world.node1.name);
    const snap = snapshot([node], {
      [world.node1.id]: [
        container({ id: world.web.dockerContainerId, status: "stopped", restartPolicy: "always", health: "unhealthy" })
      ]
    });

    const conditions = await deriveContainerConditions(snap);
    expect(conditions.filter((c) => c.conditionType === CONDITION.CONTAINER_UNHEALTHY)).toHaveLength(0);
    expect(conditions.filter((c) => c.conditionType === CONDITION.CONTAINER_UNEXPECTED_STOP)).toHaveLength(0);
  });

  it("without explicit intent, a stopped always-policy container remains unexpected", async () => {
    const node = nodeView(world.node1.id, world.node1.name);
    const snap = snapshot([node], {
      [world.node1.id]: [
        container({ id: "no-intent-stopped", status: "stopped", restartPolicy: "always" })
      ]
    });
    const conditions = await deriveContainerConditions(snap);
    const item = conditions.find((c) => c.resourceId === `${world.node1.id}:no-intent-stopped`);
    expect(item?.conditionType).toBe(CONDITION.CONTAINER_UNEXPECTED_STOP);
    expect(item?.severity).toBe("critical");
  });

  it("getExpectedStates only returns containers with explicit intent", async () => {
    await prisma.container.update({ where: { id: world.web.id }, data: { expectedState: "RUNNING" } });
    const map = await getExpectedStates([world.node1.id]);
    expect(map.get(`${world.node1.id}:${world.web.dockerContainerId}`)).toBe("RUNNING");
    // worker has no expectedState → absent from the map
    expect(map.get(`${world.node1.id}:${world.worker.dockerContainerId}`)).toBeUndefined();
  });
});

describe("workload health respects expected state", () => {
  const node = { id: "node-x", name: "Main VPS", hostname: "host", status: "ONLINE" };

  function projectWith(ids: string[]) {
    return {
      id: "project-x",
      name: "Mailcow",
      slug: "mailcow",
      description: null,
      source: "COMPOSE",
      composeProject: "mailcow",
      node,
      clientAccount: null,
      grants: [],
      containers: ids.map((id) => ({ dockerContainerId: id, dockerName: id }))
    };
  }

  it("4 running + 1 intentionally stopped is healthy and truthfully counted", () => {
    const ids = ["a", "b", "c", "d", "e"];
    const expected = new Map<string, "RUNNING" | "STOPPED">([[`${node.id}:e`, "STOPPED"]]);
    const live = ids.map((id) =>
      container({ id, status: id === "e" ? "stopped" : "running", restartPolicy: "always" })
    );
    const detail = toWorkloadDetail(projectWith(ids), live, expected);
    expect(detail.runningContainers).toBe(4);
    expect(detail.intentionallyStoppedContainers).toBe(1);
    expect(detail.stoppedContainers).toBe(1);
    expect(detail.unhealthyContainers).toBe(0);
    expect(detail.health).toBe("healthy");
  });

  it("4 running + 1 unhealthy (expected running) is degraded", () => {
    const ids = ["a", "b", "c", "d", "e"];
    const live = ids.map((id) =>
      container({ id, status: id === "e" ? "running" : "running", health: id === "e" ? "unhealthy" : null })
    );
    const detail = toWorkloadDetail(projectWith(ids), live, new Map());
    expect(detail.unhealthyContainers).toBe(1);
    expect(detail.health).toBe("degraded");
  });

  it("1 expected-running container externally stopped is down (unexpected)", () => {
    const ids = ["a"];
    const live = ids.map((id) => container({ id, status: "stopped", restartPolicy: "always" }));
    const detail = toWorkloadDetail(projectWith(ids), live, new Map());
    expect(detail.health).toBe("down");
    expect(detail.intentionallyStoppedContainers).toBe(0);
  });
});
