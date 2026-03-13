export type RuntimeContainer = {
  id: string;
  name: string;
  image: string;
  status: "running" | "stopped" | "restarting" | "unhealthy" | "unknown";
  uptime: string | null;
  ports: string;
  createdAt: string | null;
  cpuPercent: number | null;
  memoryUsage: string | null;
  restartCount: number | null;
  lastUpdatedAt: string;
};

export interface DockerAdapter {
  health(): Promise<boolean>;
  listContainers(): Promise<RuntimeContainer[]>;
  getContainer(containerId: string): Promise<RuntimeContainer | null>;
  getContainerLogs(containerId: string, tail: number): Promise<string[]>;
  runAction(containerId: string, action: "start" | "stop" | "restart"): Promise<boolean>;
}
