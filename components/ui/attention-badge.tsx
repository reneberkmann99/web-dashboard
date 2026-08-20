import { Badge } from "@/components/ui/badge";
import type { AttentionSeverity } from "@/types/domain";

/**
 * Consistent attention-severity rendering everywhere a severity appears
 * (Overview, Workloads, Containers, Nodes) — one place decides what
 * "critical/warning/info/healthy/unknown" looks like, so no page invents its
 * own color mapping (§19: one documented source of truth for terminology).
 */
export function AttentionBadge({
  severity,
  label
}: {
  severity: AttentionSeverity | "healthy" | "unknown";
  label?: string;
}): React.JSX.Element {
  const variant = severity === "critical"
    ? "danger"
    : severity === "warning"
      ? "warning"
      : severity === "info"
        ? "info"
        : severity === "healthy"
          ? "success"
          : "default";
  const text = label ?? (severity === "healthy" ? "healthy" : severity === "unknown" ? "unknown" : severity);
  return <Badge variant={variant}>{text}</Badge>;
}
