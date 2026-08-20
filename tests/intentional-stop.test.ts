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
  it("a stopped container with explicit operator intent is intentional, not unexpected", async () => {
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
    const stopped = conditions.find(
      (c) => c.resourceId === `${world.node1.id}:${world.web.dockerContainerId}`
    );
    expect(stopped?.conditionType).toBe(CONDITION.CONTAINER_STOPPED_INTENTIONAL);
    expect(stopped?.severity).toBe("info");
    expect(conditions.some((c) => c.conditionType === CONDITION.CONTAINER_UNEXPECTED_STOP)).toBe(false);
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
