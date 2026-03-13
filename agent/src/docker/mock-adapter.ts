import { DockerAdapter, RuntimeContainer } from "./types";

const mockContainers: RuntimeContainer[] = [
  {
    id: "acme-web-1",
    name: "acme-web",
    image: "ghcr.io/acme/web:latest",
    status: "running",
    uptime: "3 hours",
    ports: "80/tcp -> 0.0.0.0:8080",
    createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    cpuPercent: 1.23,
    memoryUsage: "142MiB / 2GiB",
    restartCount: 0,
    lastUpdatedAt: new Date().toISOString()
  },
  {
    id: "acme-worker-1",
    name: "acme-worker",
    image: "ghcr.io/acme/worker:latest",
    status: "restarting",
    uptime: null,
    ports: "-",
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    cpuPercent: 0.2,
    memoryUsage: "81MiB / 2GiB",
    restartCount: 4,
    lastUpdatedAt: new Date().toISOString()
  },
  {
    id: "northstar-api-1",
    name: "northstar-api",
    image: "ghcr.io/northstar/api:stable",
    status: "stopped",
    uptime: null,
    ports: "443/tcp -> 0.0.0.0:8443",
    createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    cpuPercent: null,
    memoryUsage: null,
    restartCount: 2,
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
