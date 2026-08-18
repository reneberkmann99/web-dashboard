export type UserRole = "ADMIN" | "CLIENT" | "CLIENT_ADMIN" | "CLIENT_OPERATOR" | "CLIENT_VIEWER";

/** Roles that represent tenant-scoped (non-platform) users. */
export const CLIENT_ROLES: UserRole[] = ["CLIENT_ADMIN", "CLIENT_OPERATOR", "CLIENT_VIEWER"];

export function isClientRole(role: UserRole): boolean {
  return CLIENT_ROLES.includes(role);
}

export type NodeStatus = "ONLINE" | "OFFLINE" | "UNKNOWN" | "INACTIVE";

export type AuditResult = "SUCCESS" | "FAILURE";

export type OperationState =
  | "REQUESTED"
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED";

export type ContainerStatus =
  | "running"
  | "stopped"
  | "restarting"
  | "unhealthy"
  | "unknown";

export type ContainerDetailsView = {
  restartPolicy?: string | null;
  labels?: Record<string, string>;
  networks?: Array<{ name: string; ipAddress: string; gateway: string }>;
  mounts?: Array<{ type: string; source: string; destination: string; mode: string }>;
  imageId?: string | null;
  health?: string | null;
};

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
  details?: ContainerDetailsView | null;
};

/** Item in the Needs attention section of the Overview dashboard. */
export type AttentionItem = {
  severity: "critical" | "warning" | "info";
  category: string;
  title: string;
  detail: string;
  resourceType: "node" | "container" | "operation" | "client";
  resourceId: string | null;
  nodeId: string | null;
};

/** Workload (Project/Stack) summary for the Workloads page. */
export type WorkloadSummary = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  nodeId: string;
  nodeName: string;
  clientId: string | null;
  clientName: string | null;
  totalContainers: number;
  runningContainers: number;
  stoppedContainers: number;
  unhealthyContainers: number;
  health: "healthy" | "degraded" | "down" | "unknown";
  cpuPercent: number | null;
  memoryUsage: string | null;
  lastEvent: { action: string; createdAt: string; result: string } | null;
};

export type OperationView = {
  id: string;
  type: string;
  state: OperationState;
  requestId: string;
  actorEmail: string | null;
  actorRole: UserRole | null;
  nodeName: string;
  dockerContainerId: string;
  error: string | null;
  requestedAt: string;
  queuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
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

/** Admin overview dashboard response */
export type AdminOverview = {
  totalClients: number;
  totalNodes: number;
  totalContainers: number;
  runningContainers: number;
  stoppedContainers: number;
  offlineNodes: number;
  recentActions: Array<{
    id: string;
    action: string;
    actorEmail: string | null;
    result: AuditResult;
    createdAt: string;
  }>;
};

/** Admin client list record */
export type ClientRecord = {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  _count: { users: number; assignments: number; grants: number };
};

/** Admin node list record */
export type NodeRecord = {
  id: string;
  name: string;
  hostname: string;
  apiBaseUrl: string;
  status: NodeStatus;
  isActive: boolean;
  agentVersion: string | null;
  dockerVersion: string | null;
  lastHeartbeatAt: string | null;
  osInfo: Record<string, unknown> | null;
  systemInfo: Record<string, unknown> | null;
  liveContainerCount: number;
  liveRunningCount: number;
  staleHeartbeat: boolean;
  _count: { assignments: number; containers?: number };
};

/** Admin user list record */
export type UserRecord = {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  isActive: boolean;
  clientAccountId: string | null;
  clientAccount: { id: string; name: string } | null;
};

/** Minimal name+id reference used in dropdowns */
export type NameRef = { id: string; name: string };

/** Admin assignment list record */
export type AssignmentRecord = {
  id: string;
  dockerName: string;
  dockerContainerId: string;
  image: string | null;
  isActive: boolean;
  clientAccount: { name: string };
  node: { name: string };
  project: { name: string } | null;
  allowedActions: string[];
};

/** Admin project/stack list record */
export type ProjectRecord = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  isActive: boolean;
  node: { id: string; name: string };
  clientAccount: { id: string; name: string };
  _count: { assignments: number; grants: number; containers: number };
};

/** Discovered container inventory entry offered to admins when granting access */
export type DiscoveredContainer = {
  dockerContainerId: string;
  dockerName: string;
  image: string;
  status: string | null;
  nodeId: string;
  nodeName: string;
};

/** Single audit log entry */
export type AuditLogEntry = {
  id: string;
  createdAt: string;
  actorEmail: string | null;
  actorRole: UserRole | null;
  action: string;
  targetType: string;
  targetId: string | null;
  result: AuditResult;
  sourceIp: string | null;
};
