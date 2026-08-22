import { formatDistanceToNow } from "date-fns";

/** "3m ago" style relative time. */
export function timeAgo(iso: string | Date | null | undefined): string {
  if (!iso) return "never";
  const date = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(date.getTime())) return "—";
  try {
    return formatDistanceToNow(date, { addSuffix: true });
  } catch {
    return "—";
  }
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`;
}

/** Shorten a 64-hex docker id to its 12-char form. */
export function shortId(id: string | null | undefined, len = 12): string {
  if (!id) return "—";
  return id.length > len ? id.slice(0, len) : id;
}

export function formatDateTime(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  const date = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

/**
 * Compact a docker `memoryUsage` string ("43.86MiB / 23.48GiB") into a
 * single dense value for table rows ("43.9M") — design §05.3. The full pair
 * remains available in detail views. Falls back to the raw string if it
 * cannot be confidently parsed (never silently drops data).
 */
export function compactMemory(memoryUsage: string | null | undefined): string {
  if (!memoryUsage) return "—";
  const used = memoryUsage.split("/")[0]?.trim();
  if (!used) return memoryUsage;
  const match = /^([\d.]+)\s*([A-Za-z]+)$/.exec(used);
  if (!match) return memoryUsage;
  const value = Number(match[1]);
  if (Number.isNaN(value)) return memoryUsage;
  const unit = match[2].toUpperCase();
  // Normalize to MiB, then pick the compact suffix.
  const mib = unit.startsWith("G") ? value * 1024 : unit.startsWith("K") ? value / 1024 : unit.startsWith("T") ? value * 1024 * 1024 : value;
  if (mib >= 1024 * 1024) return `${(mib / (1024 * 1024)).toFixed(1)}T`;
  if (mib >= 1024) return `${(mib / 1024).toFixed(1)}G`;
  if (mib >= 1) return `${mib.toFixed(1)}M`;
  return `${(mib * 1024).toFixed(0)}K`;
}

/**
 * Compact a docker `uptime`/Status string ("Up 4 weeks (healthy)", "Up 2
 * minutes", "Exited (0) 3 hours ago") into a dense duration ("4w", "2m") for
 * table rows — health is carried separately by the state badge, so the
 * parenthetical health suffix is intentionally dropped here. Falls back to
 * the raw string when the shape isn't recognized (never fabricates a value).
 */
export function compactUptime(uptime: string | null | undefined): string {
  if (!uptime) return "—";
  const match = /(\d+)\s*(second|minute|hour|day|week|month|year)s?/i.exec(uptime);
  if (!match) return uptime;
  const n = match[1];
  const unitChar: Record<string, string> = {
    second: "s",
    minute: "m",
    hour: "h",
    day: "d",
    week: "w",
    month: "mo",
    year: "y"
  };
  const suffix = unitChar[match[2].toLowerCase()] ?? "";
  return `${n}${suffix}`;
}

export function maskSecrets(text: string): string {
  // crude but effective: redact common secret shapes in log lines
  return text
    .replace(/(password|passwd|secret|token|api[_-]?key)\s*[=:]\s*\S+/gi, "$1=••••••")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/g, "$1••••••");
}

export function humanizeAction(action: string): string {
  const normalized = action.trim().toUpperCase();
  const map: Record<string, string> = {
    CONTAINER_RESTART: "Restarted container",
    CONTAINER_START: "Started container",
    CONTAINER_STOP: "Stopped container",
    CONTAINER_RESTART_REQUESTED: "Restart requested",
    CONTAINER_START_REQUESTED: "Start requested",
    CONTAINER_STOP_REQUESTED: "Stop requested",
    LOGIN_SUCCESS: "Signed in",
    LOGIN_FAILED: "Failed sign-in",
    USER_CREATE: "Invited user",
    USER_UPDATE: "Updated user access",
    USER_ACTIVATE: "Reactivated user",
    USER_DEACTIVATE: "Deactivated user",
    USER_REINVITE: "Reissued user invitation",
    USER_DELETE: "Deleted user",
    MEMBERSHIP_ROLE_CHANGED: "Changed member role",
    MEMBERSHIP_REMOVED: "Removed organization membership",
    PROJECT_CONVERT_TO_COMPOSE: "Converted to Compose",
    PROJECT_DETACH_COMPOSE: "Detached from Compose tracking",
    COMPOSE_ADOPT: "Adopted Compose project",
    CLIENT_CREATE: "Created organization",
    CLIENT_UPDATE: "Updated organization",
    CLIENT_DEACTIVATE: "Deactivated organization",
    PROJECT_CREATE: "Created workload",
    PROJECT_UPDATE: "Updated workload",
    PROJECT_DEACTIVATE: "Deactivated workload",
    WORKLOAD_RESTART: "Restarted workload",
    ASSIGNMENT_CREATE: "Granted container access",
    ASSIGNMENT_UPDATE: "Updated container grant",
    ASSIGNMENT_DELETE: "Revoked container access",
    GRANT_CREATE: "Granted access",
    GRANT_UPDATE: "Updated grant",
    GRANT_DEACTIVATE: "Revoked grant",
    NODE_CREATE: "Registered node",
    NODE_UPDATE: "Updated node",
    NODE_DEACTIVATE: "Disabled node",
    NODE_ENROLLED: "Enrolled node",
    NODE_ENROLLMENT_TOKEN_CREATED: "Created enrollment token",
    NODE_ENROLL_FAILED: "Node enrollment failed",
    LOGOUT: "Signed out",
    ACCOUNT_ACTIVATED: "Activated account",
    ACCOUNT_ACTIVATE_FAILED: "Account activation failed",
    LOGIN_RATE_LIMITED: "Sign-in rate limited",
    DEPLOYMENT_CREATED: "Created managed deployment",
    DEPLOYMENT_DEFINITION_CREATED: "Created managed deployment",
    REVISION_CREATED: "Saved configuration revision",
    DEPLOYMENT_REVISION_CREATED: "Saved configuration revision",
    DEPLOYMENT_PLAN_CREATED: "Generated deployment plan",
    DEPLOY_REQUESTED: "Deployment requested",
    DEPLOY_SUCCEEDED: "Deployment succeeded",
    DEPLOY_FAILED: "Deployment failed",
    ROLLBACK_REQUESTED: "Rollback requested",
    ROLLBACK_SUCCEEDED: "Rollback completed",
    ROLLBACK_FAILED: "Rollback failed",
    DEPLOYMENT_CANCEL_REQUESTED: "Deployment cancellation requested",
    DEPLOYMENT_RUNTIME_DRIFT_DETECTED: "Deployment runtime drift detected",
    SECRET_CREATED: "Created secret",
    SECRET_ROTATED: "Rotated secret",
    SECRET_SET_ACTIVE: "Changed secret status",
    SECURITY_ACKNOWLEDGED: "Acknowledged security finding",
    DEPLOYMENT_SECURITY_ACKNOWLEDGED: "Acknowledged security finding",
    MAINTENANCE_SCHEDULED: "Maintenance scheduled",
    MAINTENANCE_STARTED: "Maintenance started",
    MAINTENANCE_ENDED: "Maintenance ended",
    MAINTENANCE_CANCELLED: "Maintenance cancelled",
    ATTENTION_NOTIFICATIONS_SILENCED: "Silenced issue notifications",
    ATTENTION_SILENCE_CANCELLED: "Cancelled notification silence",
    ATTENTION_SILENCE_EXPIRED: "Notification silence expired",
    CLIENT_NODE_ACCESS_UPDATED: "Updated deployment node access",
    NODE_CERTIFICATE_ISSUED: "Issued node certificate",
    NODE_CERTIFICATE_REVOKED: "Revoked node certificate",
    NODE_CERTIFICATE_VERIFIED: "Verified node certificate",
    NODE_TLS_ENROLLMENT_TOKEN_CREATED: "Created TLS enrollment token",
    NODE_TLS_VERIFICATION_FAILED: "Node TLS verification failed",
    NOTIFICATION_DESTINATION_CREATED: "Created notification destination",
    NOTIFICATION_DELIVERY_RETRIED: "Retried notification delivery",
    NOTIFICATION_TEST_SENT: "Sent test notification"
  };
  if (map[normalized]) return map[normalized];

  const attentionMatch = normalized.match(/^ATTENTION_(OPENED|RESOLVED)_(.+)$/);
  if (attentionMatch) {
    const [, lifecycle, condition] = attentionMatch;
    const conditions: Record<string, [string, string]> = {
      CONTAINER_UNHEALTHY: ["Container became unhealthy", "Container recovered"],
      CONTAINER_CRASH_LOOP: ["Container entered a crash loop", "Container left the crash loop"],
      CONTAINER_STOPPED_INTENTIONAL: ["Container stopped", "Container started"],
      CONTAINER_UNEXPECTED_STOP: ["Container stopped unexpectedly", "Container recovered"],
      CONTAINER_HIGH_CPU: ["Container CPU pressure detected", "Container CPU pressure cleared"],
      CONTAINER_HIGH_MEMORY: ["Container memory pressure detected", "Container memory pressure cleared"],
      WORKLOAD_DEGRADED: ["Workload became degraded", "Workload returned healthy"],
      WORKLOAD_DRIFTED: ["Workload drift detected", "Workload returned to expected state"],
      NODE_OFFLINE: ["Node went offline", "Node recovered"],
      NODE_HEARTBEAT_STALE: ["Node heartbeat became stale", "Node heartbeat recovered"],
      NODE_CPU_PRESSURE: ["Node CPU pressure detected", "Node CPU pressure cleared"],
      NODE_MEM_PRESSURE: ["Node memory pressure detected", "Node memory pressure cleared"],
      NODE_DISK_PRESSURE: ["Node disk pressure detected", "Node disk pressure cleared"],
      NODE_AGENT_OUTDATED: ["Node agent became outdated", "Node agent updated"],
      NODE_CERT_EXPIRY: ["Node certificate expiry approaching", "Node certificate renewed"],
      OPERATION_STUCK: ["Operation became stuck", "Operation completed"],
      DEPLOYMENT_FAILED: ["Deployment failed", "Deployment failure cleared"]
    };
    const labels = conditions[condition];
    if (labels) return lifecycle === "OPENED" ? labels[0] : labels[1];
  }

  if (normalized.startsWith("ATTENTION_ACKNOWLEDGED_")) return "Acknowledged attention item";
  if (normalized.startsWith("ATTENTION_UNACKNOWLEDGED_")) return "Removed attention acknowledgement";

  const cleaned = normalized
    .replace(/^CONTAINER_/, "")
    .replace(/_REQUESTED$/, " requested")
    .replace(/_SUCCEEDED$/, " succeeded")
    .replace(/_FAILED$/, " failed")
    .replaceAll("_", " ");
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
}
