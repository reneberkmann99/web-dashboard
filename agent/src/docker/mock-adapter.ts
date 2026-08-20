import { Readable } from "node:stream";
import { DockerAdapter, RuntimeContainer } from "./types";

const mockContainers: RuntimeContainer[] = [
  {
    id: "acme-web-1",
    name: "acme-web",
    image: "ghcr.io/acme/web:latest",
    status: "running",
    health: "healthy",
    uptime: "3 hours",
    ports: "80/tcp -> 0.0.0.0:8080",
    createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    cpuPercent: 1.23,
    memoryUsage: "142MiB / 2GiB",
    restartCount: 0,
    restartPolicy: "unless-stopped",
    lastUpdatedAt: new Date().toISOString()
  },
  {
    id: "acme-worker-1",
    name: "acme-worker",
    image: "ghcr.io/acme/worker:latest",
    status: "restarting",
    health: null,
    uptime: null,
    ports: "-",
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    cpuPercent: 0.2,
    memoryUsage: "81MiB / 2GiB",
    restartCount: 4,
    restartPolicy: "always",
    lastUpdatedAt: new Date().toISOString()
  },
  {
    id: "northstar-api-1",
    name: "northstar-api",
    image: "ghcr.io/northstar/api:stable",
    status: "stopped",
    health: null,
    uptime: null,
    ports: "443/tcp -> 0.0.0.0:8443",
    createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    cpuPercent: null,
    memoryUsage: null,
    restartCount: 2,
    restartPolicy: "no",
    lastUpdatedAt: new Date().toISOString()
  }
];

const mockLogs: Record<string, string[]> = {
  "acme-web-1": [
    "[INFO] Listening on :8080",
    "[INFO] Healthcheck OK",
    "[INFO] Processed request /"
  ],
  "acme-worker-1": [
    "[WARN] Retrying queue connection",
    "[INFO] Worker restart requested",
    "[INFO] Boot complete"
  ],
  "northstar-api-1": [
    "[INFO] Graceful shutdown complete"
  ]
};

export class MockDockerAdapter implements DockerAdapter {
  async version(): Promise<string | null> {
    return "0.0.0-mock";
  }

  async getContainerDetails(): Promise<NonNullable<import("./types").RuntimeContainer["details"]>> {
    return { restartPolicy: "unless-stopped", labels: { "mock": "true" }, networks: [{ name: "mock", ipAddress: "172.30.0.2", gateway: "172.30.0.1" }], mounts: [] };
  }

  async getStorageSummary(): Promise<import("./types").StorageSummaryEntry[]> {
    return [
      { type: "Images", totalCount: 5, active: 4, size: "1.2GiB", reclaimable: "300MiB" },
      { type: "Containers", totalCount: 3, active: 2, size: "120MiB", reclaimable: "0B" },
      { type: "Local Volumes", totalCount: 2, active: 1, size: "80MiB", reclaimable: "40MiB" },
      { type: "Build Cache", totalCount: 0, active: 0, size: "0B", reclaimable: "0B" }
    ];
  }

  async inspectNetworks(names: string[]): Promise<import("./types").NetworkInfo[]> {
    return names.map((name) => ({
      name,
      id: `mock-net-${name}`,
      driver: "bridge",
      scope: "local",
      internal: false,
      subnets: ["172.30.0.0/16"],
      gateways: ["172.30.0.1"],
      attachedContainers: mockContainers.map((c) => c.name)
    }));
  }

  async inspectVolumes(names: string[]): Promise<import("./types").VolumeInfo[]> {
    return names.map((name) => ({ name, driver: "local", mountpoint: `/var/lib/docker/volumes/${name}/_data` }));
  }

  async health(): Promise<boolean> {
    return true;
  }

  async listContainers(): Promise<RuntimeContainer[]> {
    return mockContainers.map((item) => ({ ...item, lastUpdatedAt: new Date().toISOString() }));
  }

  async getContainer(containerId: string): Promise<RuntimeContainer | null> {
    return (await this.listContainers()).find((container) => container.id === containerId) ?? null;
  }

  async getContainerLogs(containerId: string, tail: number): Promise<string[]> {
    return (mockLogs[containerId] ?? ["No logs"]).slice(-tail);
  }

  streamContainerLogs(containerId: string, tail: number): {
    stdout: NodeJS.ReadableStream;
    kill: () => void;
  } {
    // Mock: emit the existing tail lines immediately, then end. No live tail
    // in mock mode (the real adapter streams).
    const lines = (mockLogs[containerId] ?? ["No logs"]).slice(-tail);
    const stream = new Readable({
      read() {
        for (const line of lines) {
          this.push(`${line}\n`);
        }
        this.push(null);
      }
    });
    return { stdout: stream, kill: () => stream.destroy() };
  }

  async runAction(containerId: string, action: "start" | "stop" | "restart"): Promise<boolean> {
    const target = mockContainers.find((container) => container.id === containerId);
    if (!target) {
      return false;
    }

    if (action === "start") {
      target.status = "running";
    }
    if (action === "stop") {
      target.status = "stopped";
    }
    if (action === "restart") {
      target.status = "restarting";
      target.status = "running";
      target.restartCount = (target.restartCount ?? 0) + 1;
    }
    target.lastUpdatedAt = new Date().toISOString();

    return true;
  }
}
