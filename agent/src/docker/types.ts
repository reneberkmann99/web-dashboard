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
  /** Docker Compose project/service labels (com.docker.compose.project/service). */
  composeProject?: string | null;
  composeService?: string | null;
  /** Detailed docker inspect-derived metadata (networks, mounts, labels, …). */
  details?: ContainerDetails | null;
};

export type ContainerDetails = {
  restartPolicy?: string | null;
  labels?: Record<string, string>;
  networks?: Array<{ name: string; ipAddress: string; gateway: string }>;
  mounts?: Array<{ type: string; source: string; destination: string; mode: string }>;
  imageId?: string | null;
  state?: string | null;
  health?: string | null;
};

export interface DockerAdapter {
  health(): Promise<boolean>;
  /** Docker server version string, e.g. "29.6.2"; null when unavailable. */
  version?(): Promise<string | null>;
  listContainers(): Promise<RuntimeContainer[]>;
  getContainer(containerId: string): Promise<RuntimeContainer | null>;
  getContainerLogs(containerId: string, tail: number): Promise<string[]>;
  /**
   * Stream a container's logs (tail + follow). Returns the stdout stream and
   * a kill() to tear the underlying process down when the consumer goes away.
   * Lines are emitted raw (newline-separated).
   */
  streamContainerLogs(containerId: string, tail: number): {
    stdout: NodeJS.ReadableStream;
    kill: () => void;
  };
  runAction(containerId: string, action: "start" | "stop" | "restart"): Promise<boolean>;
}
