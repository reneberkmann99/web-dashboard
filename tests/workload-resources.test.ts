import { beforeAll, describe, expect, it, vi } from "vitest";
import { resetDatabase } from "./setup";
import { seedWorld, sessionFor } from "./helpers/fixtures";
import { getWorkloadResources, canViewWorkloadResources } from "@/server/services/workload-resources";
import type { RuntimeContainer } from "@/server/services/node-agent/types";

let world: Awaited<ReturnType<typeof seedWorld>>;

function makeContainer(
  id: string,
  overrides: Partial<RuntimeContainer> = {}
): RuntimeContainer {
  return {
    id,
    name: id,
    image: "nginx:latest",
    status: "running",
    uptime: null,
    ports: "-",
    createdAt: null,
    cpuPercent: null,
    memoryUsage: null,
    restartCount: 0,
    lastUpdatedAt: new Date().toISOString(),
    ...overrides
  };
}

// Live inventory on node1 (where projectA lives):
//  - web  (member of projectA): web-net + shared-net, volume app-data, bind /opt/secret → /config, tmpfs /tmp
//  - worker (NOT a member): shared-net + app-data — makes both shared.
const node1Inventory = [
  makeContainer("web1234567890", {
    networkNames: ["web-net", "shared-net"],
    mountRefs: [
      { type: "volume", source: "", destination: "/app/data", mode: "rw", volumeName: "app-data" },
      { type: "bind", source: "/opt/secret-company/project/config", destination: "/config", mode: "ro", volumeName: null },
      { type: "tmpfs", source: "", destination: "/tmp", mode: "rw", volumeName: null }
    ]
  }),
  makeContainer("worker12345678", {
    networkNames: ["shared-net"],
    mountRefs: [{ type: "volume", source: "", destination: "/data", mode: "rw", volumeName: "app-data" }]
  })
];

vi.mock("@/server/services/node-agent/client", () => ({
  nodeAgentClient: {
    listContainers: vi.fn(async () => ({ nodeOnline: true, containers: node1Inventory })),
    getContainer: vi.fn(async () => ({ nodeOnline: true, container: null })),
    getLogs: vi.fn(async () => ({ nodeOnline: true, logs: [] })),
    runAction: vi.fn(async () => true),
    checkHealth: vi.fn(async () => true),
    getNodeInfo: vi.fn(async () => ({})),
    streamLogs: vi.fn(async () => null),
    getStorageSummary: vi.fn(async () => []),
    inspectNetworks: vi.fn(async (_node: unknown, names: string[]) =>
      names.map((name) => ({
        name,
        id: `net-${name}`,
        driver: "bridge",
        scope: "local",
        internal: false,
        subnets: name === "shared-net" ? ["172.28.0.0/16"] : ["172.30.0.0/16"],
        gateways: ["172.28.0.1"],
        attachedContainers: name === "shared-net" ? ["web", "worker"] : ["web"]
      }))
    ),
    inspectVolumes: vi.fn(async (_node: unknown, names: string[]) =>
      names.map((name) => ({ name, driver: "local", mountpoint: `/var/lib/docker/volumes/${name}/_data` }))
    )
  }
}));

beforeAll(async () => {
  resetDatabase();
  world = await seedWorld();
});

describe("workload networks aggregation", () => {
  it("aggregates the workload's networks with attached containers", async () => {
    const admin = sessionFor(world.adminA);
    const { networks } = (await getWorkloadResources(world.projectA.id, admin))!;

    const names = networks.map((n) => n.name).sort();
    expect(names).toEqual(["shared-net", "web-net"]);

    const webNet = networks.find((n) => n.name === "web-net");
    expect(webNet?.driver).toBe("bridge");
    expect(webNet?.workloadContainers).toContain("web1234567890");
    expect(webNet?.subnets).toContain("172.30.0.0/16");
  });

  it("detects a shared network (containers outside the workload attached)", async () => {
    const admin = sessionFor(world.adminA);
    const { networks } = (await getWorkloadResources(world.projectA.id, admin))!;

    const shared = networks.find((n) => n.name === "shared-net");
    expect(shared?.shared.kind).toBe("shared_with_others");
    if (shared?.shared.kind === "shared_with_others") {
      expect(shared.shared.otherContainerCount).toBe(1);
    }
    expect(shared?.totalAttachedCount).toBe(2);

    const exclusive = networks.find((n) => n.name === "web-net");
    expect(exclusive?.shared.kind).toBe("exclusive");
  });
});

describe("workload volumes aggregation", () => {
  it("aggregates named volumes, bind mounts and tmpfs", async () => {
    const admin = sessionFor(world.adminA);
    const { volumes } = (await getWorkloadResources(world.projectA.id, admin))!;

    const named = volumes.find((v) => v.kind === "volume");
    expect(named?.kind).toBe("volume");
    if (named?.kind === "volume") {
      expect(named.volumeName).toBe("app-data");
      expect(named.driver).toBe("local");
      expect(named.workloadContainers).toContain("web1234567890");
    }

    const bind = volumes.find((v) => v.kind === "bind");
    expect(bind?.kind).toBe("bind");
    if (bind?.kind === "bind") {
      expect(bind.destination).toBe("/config");
      expect(bind.mode).toBe("ro");
    }

    const tmpfs = volumes.find((v) => v.kind === "tmpfs");
    expect(tmpfs?.kind).toBe("tmpfs");
    if (tmpfs?.kind === "tmpfs") {
      expect(tmpfs.destination).toBe("/tmp");
    }
  });

  it("detects a shared named volume (mounted by non-workload container)", async () => {
    const admin = sessionFor(world.adminA);
    const { volumes } = (await getWorkloadResources(world.projectA.id, admin))!;

    const named = volumes.find((v) => v.kind === "volume");
    expect(named?.kind).toBe("volume");
    if (named?.kind === "volume") {
      expect(named.shared.kind).toBe("shared_with_others");
      if (named.shared.kind === "shared_with_others") {
        expect(named.shared.otherContainerCount).toBe(1);
      }
    }
  });
});

describe("tenant visibility of host bind paths", () => {
  it("CLIENT never receives host bind source paths", async () => {
    const client = sessionFor(world.clientAOperator);
    const { volumes } = (await getWorkloadResources(world.projectA.id, client))!;

    const bind = volumes.find((v) => v.kind === "bind");
    expect(bind?.kind).toBe("bind");
    if (bind?.kind === "bind") {
      expect(bind.sourcePath).toBeNull();
      expect(bind.sourceHidden).toBe(true);
      expect(bind.destination).toBe("/config"); // destination is still useful
    }
  });

  it("ADMIN sees full bind source paths", async () => {
    const admin = sessionFor(world.adminA);
    const { volumes } = (await getWorkloadResources(world.projectA.id, admin))!;

    const bind = volumes.find((v) => v.kind === "bind");
    expect(bind?.kind).toBe("bind");
    if (bind?.kind === "bind") {
      expect(bind.sourcePath).toBe("/opt/secret-company/project/config");
      expect(bind.sourceHidden).toBe(false);
    }
  });

  it("client without a grant cannot view the workload's resources", async () => {
    // clientB has no grant on projectA (owned by clientA).
    const b = sessionFor(world.clientBOperator);
    expect(await canViewWorkloadResources(b, world.projectA.id)).toBe(false);

    // Client A operator can (owns the workload's client).
    const a = sessionFor(world.clientAOperator);
    expect(await canViewWorkloadResources(a, world.projectA.id)).toBe(true);

    // ADMIN can.
    const admin = sessionFor(world.adminA);
    expect(await canViewWorkloadResources(admin, world.projectA.id)).toBe(true);
  });
});
