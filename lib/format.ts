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

export function maskSecrets(text: string): string {
  // crude but effective: redact common secret shapes in log lines
  return text
    .replace(/(password|passwd|secret|token|api[_-]?key)\s*[=:]\s*\S+/gi, "$1=••••••")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/g, "$1••••••");
}

export function humanizeAction(action: string): string {
  const map: Record<string, string> = {
    CONTAINER_RESTART: "Restarted container",
    CONTAINER_START: "Started container",
    CONTAINER_STOP: "Stopped container",
    CONTAINER_RESTART_REQUESTED: "Restart requested",
    CONTAINER_START_REQUESTED: "Start requested",
    CONTAINER_STOP_REQUESTED: "Stop requested",
    LOGIN_SUCCESS: "Signed in",
    LOGIN_FAILED: "Failed sign-in",
    USER_CREATE: "Created user",
    USER_UPDATE: "Updated user",
    CLIENT_CREATE: "Created client",
    CLIENT_UPDATE: "Updated client",
    CLIENT_DEACTIVATE: "Deactivated client",
    PROJECT_CREATE: "Created workload",
    PROJECT_UPDATE: "Updated workload",
    PROJECT_DEACTIVATE: "Deactivated workload",
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
    LOGIN_RATE_LIMITED: "Sign-in rate limited"
  };
  if (map[action]) return map[action];
  const cleaned = action
    .replace(/^CONTAINER_/, "")
    .replace(/_REQUESTED$/, " requested")
    .replace(/_SUCCEEDED$/, " succeeded")
    .replace(/_FAILED$/, " failed");
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
}
