export type UserRole = "ADMIN" | "CLIENT";

export type NodeStatus = "ONLINE" | "OFFLINE" | "UNKNOWN" | "INACTIVE";

export type AuditResult = "SUCCESS" | "FAILURE";

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
  _count: { users: number; assignments: number };
};

/** Admin node list record */
export type NodeRecord = {
  id: string;
  name: string;
  hostname: string;
  apiBaseUrl: string;
  status: NodeStatus;
  isActive: boolean;
  _count: { assignments: number };
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
