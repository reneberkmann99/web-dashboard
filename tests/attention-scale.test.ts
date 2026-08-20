import { describe, expect, it } from "vitest";
import { computeUtilization, type NodeOperationalView, type OverviewSnapshot } from "@/server/services/overview";
import { deriveContainerConditions } from "@/server/services/attention";
import type { RuntimeContainer } from "@/server/services/node-agent/types";

describe("Phase 6D realistic fleet scale", () => {
  it("derives a 20-node / 100-workload / 500-container snapshot without per-container timers or requests", async () => {
    const nodes: NodeOperationalView[] = [];
    const containersByNode = new Map<string, RuntimeContainer[]>();
    const workloadNames = new Set<string>();

    for (let nodeIndex = 0; nodeIndex < 20; nodeIndex += 1) {
      const nodeId = `scale-node-${nodeIndex}`;
      nodes.push({
        id: nodeId,
        name: `Scale Node ${nodeIndex}`,
        hostname: `${nodeId}.test`,
        status: "ONLINE",
        isActive: true,
        lastHeartbeatAt: new Date(),
        heartbeatState: "ONLINE",
        agentVersion: "0.4.0",
        dockerVersion: "29.0.0",
        systemInfo: null,
        containerCount: 25,
        runningCount: 25,
        polledOnline: true,
        offline: false,
        staleHeartbeat: false
      });
      const containers: RuntimeContainer[] = [];
      for (let containerIndex = 0; containerIndex < 25; containerIndex += 1) {
        const globalIndex = nodeIndex * 25 + containerIndex;
        const workload = `scale-workload-${globalIndex % 100}`;
        workloadNames.add(workload);
        containers.push({
          id: `scale-container-${globalIndex}`,
          name: `container-${globalIndex}`,
          image: "busybox:stable",
          status: "running",
          health: "healthy",
          uptime: "1h",
          ports: "-",
          createdAt: new Date().toISOString(),
          cpuPercent: 1,
          memoryUsage: "10MiB / 1GiB",
          restartCount: 0,
          restartPolicy: "unless-stopped",
          composeProject: workload,
          lastUpdatedAt: new Date().toISOString()
        });
      }
      containersByNode.set(nodeId, containers);
    }

    const snapshot: OverviewSnapshot = { nodes, containersByNode };
    const startedAt = performance.now();
    const utilization = computeUtilization(containersByNode);
    const conditions = await deriveContainerConditions(snapshot);
    const elapsedMs = performance.now() - startedAt;

    expect(nodes).toHaveLength(20);
    expect(workloadNames).toHaveLength(100);
    expect(utilization.totalContainers).toBe(500);
    expect(utilization.runningContainers).toBe(500);
    expect(conditions).toHaveLength(0);
    // Deliberately generous for shared CI; catches accidental N+1 network or
    // per-container timeout behavior without turning this into a microbenchmark.
    expect(elapsedMs).toBeLessThan(5_000);
  });
});
