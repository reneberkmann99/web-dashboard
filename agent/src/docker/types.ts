export type RuntimeContainer = {
  id: string;
  name: string;
  image: string;
  status: "running" | "stopped" | "restarting" | "unhealthy" | "unknown";
  /** Docker healthcheck state, deliberately separate from runtime state. */
  health?: "healthy" | "unhealthy" | "starting" | null;
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
  /**
   * Lightweight network/mount references captured during the per-container
   * inspect that `listContainers()` already performs — cheap to include
   * (zero extra Docker calls) and enough for workload-level Networks/Volumes
   * aggregation without inspecting every container again.
   */
  networkNames?: string[];
  mountRefs?: Array<{ type: string; source: string; destination: string; mode: string; volumeName: string | null }>;
  /**
   * Docker restart policy name (e.g. "always", "unless-stopped", "no"),
   * captured during the EXISTING per-container inspect in `listContainers()`
   * — zero extra Docker calls. Used by the attention model to distinguish a
   * container that is "supposed to be running" (policy always/unless-stopped)
   * but is unexpectedly stopped, from an intentionally one-shot/manual
   * container (policy no/on-failure) that stopping is normal for.
   */
  restartPolicy?: string | null;
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
  /** Docker disk usage summary (images/containers/volumes/build-cache). */
  getStorageSummary?(): Promise<StorageSummaryEntry[]>;
  /** Batch-inspect specific networks by name (bounded by caller). */
  inspectNetworks?(names: string[]): Promise<NetworkInfo[]>;
  /** Batch-inspect specific named volumes by name (bounded by caller). */
  inspectVolumes?(names: string[]): Promise<VolumeInfo[]>;
}

export type StorageSummaryEntry = {
  type: string;
  totalCount: number;
  active: number;
  size: string;
  reclaimable: string;
};

export type NetworkInfo = {
  name: string;
  id: string;
  driver: string;
  scope: string;
  internal: boolean;
  subnets: string[];
  gateways: string[];
  /** Names of every container currently attached to this network on this node. */
  attachedContainers: string[];
};

export type VolumeInfo = {
  name: string;
  driver: string;
  /** Host filesystem mountpoint. Admin-only at the control-plane layer. */
  mountpoint: string | null;
};
