/** Shared types for the managed-deployment UI (Phase 6C). */

export type DeploymentRuntimeState = "UNKNOWN" | "CONVERGED" | "DEGRADED" | "DRIFTED";

export type ReleaseListItem = {
  id: string;
  displayNumber: number;
  revisionId: string;
  revisionNumber: number;
  operationId: string;
  operationType: "DEPLOY" | "ROLLBACK";
  operationState: string;
  actorEmail: string | null;
  healthVerdict: "HEALTHY" | "DEGRADED";
  appliedAt: string;
  verifiedAt: string | null;
  failureReason: string | null;
  isCurrent: boolean;
  isLastHealthy: boolean;
  sameRevisionAsPrevious: boolean;
  images: Array<{ serviceName: string; imageRef: string; imageId: string | null; repoDigest: string | null }>;
  secrets: Array<{ key: string; versionNumber: number }>;
};

export type ReleasesListPayload = {
  data: ReleaseListItem[];
  total: number;
  runtimeState: DeploymentRuntimeState;
  currentReleaseId: string | null;
  lastHealthyReleaseId: string | null;
};

export type ReleaseDetailPayload = ReleaseListItem & {
  composeVersion: string | null;
  revisionCreatedAt: string;
  revisionCreatedBy: string | null;
  deployNote: string | null;
  deploymentId: string;
  composeProjectName: string;
  deploymentRuntimeState: string;
  operationResult: {
    verifyVerdict: string | null;
    runtimeConverged: boolean | null;
    health: string | null;
    planHash: string | null;
    applyError: string | null;
    cancelled: boolean | null;
    recovered: boolean | null;
  };
  rotatedSecretKeys: string[];
  previousRelease: { id: string; displayNumber: number } | null;
};

export type DeploymentDetailPayload = {
  id: string;
  projectId: string;
  source: string;
  composeProjectName: string;
  currentReleaseId: string | null;
  lastHealthyReleaseId: string | null;
  runtimeState: DeploymentRuntimeState;
  ownershipMode: string;
  project: {
    id: string;
    name: string;
    slug: string;
    source: string;
    composeProject: string | null;
    nodeId: string;
    node: { id: string; name: string };
  };
  createdAt: string;
  updatedAt: string;
};

export type WorkloadDeploymentStatus = {
  managed: boolean;
  deploymentId: string | null;
  runtimeState: DeploymentRuntimeState | null;
  currentRelease: {
    id: string;
    displayNumber: number | null;
    revisionId: string;
    revisionNumber: number;
    healthVerdict: string;
    appliedAt: string | null;
    operationId: string | null;
    operationType: string | null;
    operationState: string | null;
    actorEmail: string | null;
  } | null;
  lastHealthyRelease: { id: string; displayNumber: number | null; revisionNumber: number } | null;
  activeOperation: {
    id: string;
    type: string;
    state: string;
    phase: string | null;
    actorEmail: string | null;
    startedAt: string | null;
  } | null;
};

export type RevisionDetailPayload = {
  id: string;
  deploymentId: string;
  revisionNumber: number;
  source: string;
  sourceRef: string | null;
  composeSource: string;
  composeCanonical: string;
  environmentSnapshot: Record<string, string>;
  secretReferences: string[];
  contentSha256: string;
  deployNote: string | null;
  analyzerVersion: string;
  createdAt: string;
  createdBy: string | null;
  findings: unknown[];
};

export type PlanService = {
  serviceName: string;
  action: "CREATE" | "RECREATE" | "UNCHANGED" | "REMOVE_CANDIDATE";
  changes: string[];
  certainty: "CONFIRMED" | "PREDICTED" | "UNKNOWN";
};

export type DeploymentPlanPayload = {
  deploymentId: string;
  revisionId: string;
  fromRevisionNumber: number | null;
  toRevisionNumber: number;
  services: PlanService[];
  secretChanges: Array<{
    key: string;
    currentVersionNumber: number | null;
    targetVersionNumber: number | null;
    changed: boolean;
    missing: boolean;
  }>;
  images: Array<{ serviceName: string; imageRef: string | null; digestKnown: false }>;
  networks: Array<{ name: string; action: "CREATE" | "UNCHANGED" }>;
  volumes: Array<{ name: string; action: "CREATE" | "UNCHANGED" }>;
  summary: {
    create: number;
    recreate: number;
    unchanged: number;
    removeCandidates: number;
    volumesRemoved: number;
    networksRemoved: number;
  };
  planHash: string;
};

export type DeploymentOperationPayload = {
  id: string;
  type: "DEPLOY" | "ROLLBACK";
  state: "REQUESTED" | "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  phase: string | null;
  revisionId: string | null;
  actorEmail: string | null;
  error: string | null;
  result: {
    planHash?: string;
    runtimeConverged?: boolean;
    health?: string;
    releaseId?: string;
    applyError?: string;
    cancelled?: boolean;
    recovered?: boolean;
    verify?: { verdict: string; services: Array<Record<string, unknown>> };
    [key: string]: unknown;
  } | null;
  deploymentId: string;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type SecretListItem = {
  id: string;
  key: string;
  isActive: boolean;
  latestVersion: { versionNumber: number; createdAt: string; createdBy: string | null } | null;
  createdAt: string;
  usedByServices: number;
  usedByServiceNames: string[];
};

export type SecretVersionListItem = {
  id: string;
  versionNumber: number;
  createdAt: string;
  createdBy: string | null;
};

export type RollbackTargetPayload = {
  revisionId: string;
  revisionNumber: number;
  fromReleaseId: string;
  fromReleaseHealthVerdict: string;
  fromRuntimeState: string;
  currentReleaseId: string | null;
  fromReleaseAppliedAt: string | null;
};

export type ValidateResultPayload = {
  nodeFound: boolean;
  nodeName: string | null;
  composeSupported: boolean;
  composeVersion: string | null;
  findings: Array<{ severity: string; ruleId: string; message: string; fingerprint?: string; service?: string | null; resourcePath?: string | null }>;
  composeErrors: string[];
  composeCanonical: string | null;
  valid: boolean;
  blockedFindings: Array<{ severity: string; ruleId: string; message: string; fingerprint?: string }>;
  highRiskFindings: Array<{ severity: string; ruleId: string; message: string; fingerprint?: string }>;
};
