import { beforeAll, describe, expect, it, vi } from "vitest";
import { resetDatabase } from "./setup";
import { seedWorld } from "./helpers/fixtures";
import { queryAllContainersForAdmin } from "@/server/services/containers";
import type { RuntimeContainer } from "@/server/services/node-agent/types";

function makeContainer(id: string, status: RuntimeContainer["status"], name: string): RuntimeContainer {
  return {
    id,
    name,
    image: `${name}:latest`,
    status,
    uptime: null,
    ports: "-",
    createdAt: null,
    cpuPercent: 1.0,
    memoryUsage: "10MiB / 1GiB",
    restartCount: 0,
    lastUpdatedAt: new Date().toISOString()
  };
}

// 15 containers: svc-0..svc-14; every 5th one is stopped.
function fixedInventory(): RuntimeContainer[] {
  const out: RuntimeContainer[] = [];
  for (let i = 0; i < 15; i++) {
    const status: RuntimeContainer["status"] = i % 5 === 0 ? "stopped" : "running";
    out.push(makeContainer(`c${i}`, status, `svc-${i}`));
  }
  return out;
}

vi.mock("@/server/services/node-agent/client", () => ({
  nodeAgentClient: {
    listContainers: vi.fn(async () => ({ nodeOnline: true, containers: fixedInventory() })),
    getContainer: vi.fn(async () => ({ nodeOnline: true, container: null })),
    getLogs: vi.fn(async () => ({ nodeOnline: true, logs: [] })),
    runAction: vi.fn(async () => true),
    checkHealth: vi.fn(async () => true),
    getNodeInfo: vi.fn(async () => ({})),
    streamLogs: vi.fn(async () => null)
  }
}));

beforeAll(async () => {
  resetDatabase();
  await seedWorld(); // exactly 2 nodes → 30 live containers for the mock
});

describe("admin containers server-side query", () => {
  it("paginates and reports total/pageCount", async () => {
    const page1 = await queryAllContainersForAdmin({ limit: 10, page: 1 });

    expect(page1.total).toBe(30);
    expect(page1.containers).toHaveLength(10);
    expect(page1.pageCount).toBe(3);
    expect(page1.page).toBe(1);
  });

  it("does not return more than the limit on the last page", async () => {
    const page3 = await queryAllContainersForAdmin({ limit: 10, page: 3 });
    expect(page3.containers).toHaveLength(10);
    expect(page3.total).toBe(30);
  });

  it("filters by status server-side", async () => {
    const stopped = await queryAllContainersForAdmin({ status: "stopped" });
    expect(stopped.total).toBe(6); // 3 stopped per node × 2 nodes
    for (const c of stopped.containers) {
      expect(c.status).toBe("stopped");
    }
  });

  it("filters by search across name/image", async () => {
    const result = await queryAllContainersForAdmin({ search: "svc-3" });
    // "svc-3" matches svc-3 and svc-13, times 2 nodes.
    for (const c of result.containers) {
      expect(c.name).toContain("svc-3");
    }
    expect(result.total).toBeGreaterThan(0);
  });
});
