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
  /** Docker healthcheck state, separate from runtime state. */
  health?: "healthy" | "unhealthy" | "starting" | null;
  uptime: string | null;
  ports: string;
  createdAt: string | null;
  cpuPercent: number | null;
  memoryUsage: string | null;
  restartCount: number | null;
  restartPolicy?: string | null;
  nodeId: string;
  nodeName: string;
  nodeOnline: boolean;
  projectName: string | null;
  projectId?: string | null;
  clientName: string;
  clientId?: string | null;
  allowedActions: string[];
  lastUpdatedAt: string;
  details?: ContainerDetailsView | null;
  /** Backend-derived attention severity for this container (Phase 6D). */
  attention?: "critical" | "warning" | "info" | "healthy" | "unknown";
  /** Operator-declared intent (backend-authoritative): the container is expected to stay stopped. */
  expectedStopped?: boolean;
};

/** Authoritative backend resource-pressure thresholds (attention-config.ts). */
export type ResourceThresholds = {
  cpu: { warning: number; critical: number };
  mem: { warning: number; critical: number };
  disk: { warning: number; critical: number };
};

/** Per-node live resource telemetry snapshot (real agent data only). */
export type NodeResourceTelemetry = {
  cpuPercent: number | null;
  memPercent: number | null;
  diskPercent: number | null;
  diskTotalBytes: number | null;
  diskFreeBytes: number | null;
  totalMemBytes: number | null;
  cpuCount: number | null;
  /** True when the node was reachable for this poll; false = stale/offline. */
  telemetryCurrent: boolean;
};

export type AttentionSeverity = "critical" | "warning" | "info";

/**
 * Item in the "Needs attention" section of Overview / node / workload detail
 * pages. Deduplicated and backend-derived (server/services/attention.ts) —
 * never recomputed independently per component. `href` lets a card link
 * straight to the useful investigation page (§15) instead of forcing manual
 * navigation.
 */
export type AttentionItem = {
  id: string;
  severity: AttentionSeverity;
  category: string;
  conditionType: string;
  title: string;
  detail: string;
  resourceType: "node" | "container" | "operation" | "client" | "workload" | "deployment";
  resourceId: string | null;
  nodeId: string | null;
  href: string | null;
  firstObservedAt: string;
  lastObservedAt: string;
  /** Count of lower-level items suppressed/rolled up into this one (§4 dedup). */
  affectedCount?: number;
  acknowledgement?: {
    id: string;
    acknowledgedBy: string;
    acknowledgedAt: string;
    note: string | null;
  } | null;
  silence?: {
    id: string;
    endsAt: string;
    reason: string | null;
    createdBy: string | null;
  } | null;
  maintenance?: {
    id: string;
    startsAt: string;
    endsAt: string;
    reason: string | null;
  } | null;
};

/** Workload (Project/Stack) summary for the Workloads page. */
export type WorkloadSummary = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  source: "MANUAL" | "COMPOSE" | "MANAGED";
  nodeId: string;
  nodeName: string;
  clientId: string | null;
  clientName: string | null;
  totalContainers: number;
  runningContainers: number;
  stoppedContainers: number;
  intentionallyStoppedContainers: number;
  unhealthyContainers: number;
  health: "healthy" | "degraded" | "down" | "unknown";
  cpuPercent: number | null;
  memoryUsage: string | null;
  lastEvent: { action: string; createdAt: string; result: string } | null;
  /** Backend-derived attention severity, distinct from `health` (§6/§19). */
  attention: AttentionSeverity | "healthy" | "unknown";
  managed: boolean;
  deploymentRuntimeState?: "UNKNOWN" | "CONVERGED" | "DEGRADED" | "DRIFTED" | null;
};

/** Fleet-wide summary counters for the Overview page (§2). */
export type FleetSummary = {
  nodesOnline: number;
  nodesTotal: number;
  workloadsHealthy: number;
  workloadsTotal: number;
  containersRunning: number;
  containersTotal: number;
  unhealthyContainers: number;
  activeOperations: number;
  degradedWorkloads: number;
  attentionIssues: number;
};

/** Recent failure entry for the Overview "Recent failures" section (§13). */
export type RecentFailure = {
  /** Stable grouped-incident key — also the dismissal key. */
  id: string;
  kind: string;
  title: string;
  /** Short single-line summary (latest error, truncated) — raw output lives in the resource detail, not Overview. */
  detail: string | null;
  resourceType: "node" | "container" | "operation" | "workload" | "deployment";
  resourceId: string | null;
  href: string | null;
  /** Latest occurrence. */
  createdAt: string;
  /** Number of failed attempts grouped into this incident. */
  attempts: number;
};

/** Active (in-flight) operation summary for the Overview "Active operations" section (§12). */
export type ActiveOperationSummary = {
  id: string;
  kind: "container" | "deployment";
  type: string;
  state: string;
  targetName: string;
  targetHref: string | null;
  actorEmail: string | null;
  startedAt: string | null;
  requestedAt: string;
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
  liveWorkloadCount?: number;
  staleHeartbeat: boolean;
  offline: boolean;
  attention: AttentionSeverity | "healthy" | "unknown";
  _count: { assignments: number; containers?: number };
};

/** Admin user list record */
export type UserRecord = {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  isActive: boolean;
  pending: boolean;
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
  clientAccount: { id: string; name: string } | null;
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
