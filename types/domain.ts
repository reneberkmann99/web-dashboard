export type UserRole = "ADMIN" | "CLIENT";

export type ContainerStatus =
  | "running"
  | "stopped"
  | "restarting"
  | "unhealthy"
  | "unknown";

export type ContainerView = {
  assignmentId: string;
  containerId: string;
  name: string;
  image: string;
  status: ContainerStatus;
  uptime: string | null;
  ports: string;
  createdAt: string | null;
  cpuPercent: number | null;
  memoryUsage: string | null;
  restartCount: number | null;
  nodeId: string;
  nodeName: string;
  nodeOnline: boolean;
  projectName: string | null;
  clientName: string;
  allowedActions: string[];
  lastUpdatedAt: string;
};

export type OverviewStats = {
  totalContainers: number;
  runningContainers: number;
  stoppedContainers: number;
  restartingContainers: number;
  unhealthyContainers: number;
  offlineNodes: number;
  onlineNodes: number;
};
