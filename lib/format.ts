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
