"use client";

import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/format";
import type { ResourceThresholds } from "@/types/domain";

/**
 * Noderaft resource-usage presentation (CPU / RAM / disk).
 *
 * Design rules enforced here:
 *  - Restrained usage bars, not raw "47% · 46% · 31%" text strings.
 *  - Normal usage stays visually quiet (no bright colors); only warning and
 *    critical states take on amber/red, driven by the AUTHORITATIVE backend
 *    thresholds (attention-config) — never by frontend guesses.
 *  - "Unknown" is a real state: missing telemetry renders as Unknown, never
 *    as 0% (0% would claim the resource is idle when we simply have no data).
 *  - Stale/offline telemetry is visually identified and never presented as
 *    current.
 */
export type ResourceUsageItem = {
  key: "cpu" | "mem" | "disk";
  label: string;
  /** Percentage 0–100, or null when telemetry is missing. */
  percent: number | null;
  /** Human-readable used amount, e.g. "3.0 GiB" (RAM) or "42%" (disk). */
  used?: string | null;
  /** Human-readable capacity, e.g. "16 GiB" or "80 GB". */
  capacity?: string | null;
  /** Optional raw bytes for capacity display. */
  capacityBytes?: number | null;
};

function toneFor(percent: number | null, threshold: { warning: number; critical: number }): "quiet" | "warning" | "critical" {
  if (percent === null) return "quiet";
  if (percent >= threshold.critical) return "critical";
  if (percent >= threshold.warning) return "warning";
  return "quiet";
}

const BAR_COLORS: Record<"quiet" | "warning" | "critical", string> = {
  quiet: "bg-text-muted/70",
  warning: "bg-warning",
  critical: "bg-critical"
};

const TEXT_COLORS: Record<"quiet" | "warning" | "critical", string> = {
  quiet: "text-text-muted",
  warning: "text-warning-foreground",
  critical: "text-critical-foreground"
};

/**
 * Compact horizontal usage bar with label, percentage and capacity.
 * `state` overrides tone when telemetry is stale/offline (the bar is drawn
 * muted and the copy says so) — stale data must not look live.
 */
export function UsageBar({
  item,
  thresholds,
  state = "current"
}: {
  item: ResourceUsageItem;
  thresholds: { warning: number; critical: number };
  state?: "current" | "stale" | "offline";
}): React.JSX.Element {
  const tone = state === "current" ? toneFor(item.percent, thresholds) : "quiet";
  const width = item.percent === null ? 0 : Math.min(Math.max(item.percent, 0), 100);

  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-text-muted">{item.label}</span>
        <span className={cn("font-mono text-xs tabular-nums", TEXT_COLORS[tone])}>
          {item.percent === null ? (
            "Unknown"
          ) : (
            <>
              {item.percent.toFixed(0)}%
              {item.capacity ? (
                <span className="text-text-subtle"> · {item.capacity}</span>
              ) : null}
            </>
          )}
        </span>
      </div>
      <div
        className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-raised"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={item.percent ?? undefined}
        aria-valuetext={item.percent === null ? "unknown" : `${item.percent.toFixed(0)} percent`}
        aria-label={`${item.label} usage`}
      >
        {item.percent !== null && (
          <div
            className={cn("h-full rounded-full transition-[width] duration-500", BAR_COLORS[tone])}
            style={{ width: `${width}%` }}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Full CPU / RAM / disk block. `telemetry` may carry the backend snapshot
 * fields; `state` distinguishes current / stale / offline telemetry so a
 * disconnected node never shows stale percentages as live values.
 */
export function ResourceUsage({
  cpuPercent,
  memPercent,
  diskPercent,
  diskTotalBytes,
  diskFreeBytes,
  totalMemBytes,
  cpuCount,
  telemetryCurrent,
  state,
  thresholds,
  compact = false,
  className
}: {
  cpuPercent: number | null;
  memPercent: number | null;
  diskPercent: number | null;
  diskTotalBytes?: number | null;
  diskFreeBytes?: number | null;
  totalMemBytes?: number | null;
  cpuCount?: number | null;
  /** False when the node was unreachable for the last poll (stale/offline). */
  telemetryCurrent: boolean;
  state?: "current" | "stale" | "offline";
  thresholds: ResourceThresholds;
  compact?: boolean;
  className?: string;
}): React.JSX.Element {
  const effectiveState = state ?? (telemetryCurrent ? "current" : "stale");

  const memCapacity = totalMemBytes ? formatBytes(totalMemBytes) : null;
  const diskCapacity = diskTotalBytes ? formatBytes(diskTotalBytes) : null;

  const items: ResourceUsageItem[] = [
    {
      key: "cpu",
      label: "CPU",
      percent: cpuPercent,
      used: cpuPercent !== null ? `${cpuPercent.toFixed(0)}%` : null,
      capacity: cpuCount ? `${cpuCount} cores` : null
    },
    {
      key: "mem",
      label: "RAM",
      percent: memPercent,
      used: memPercent !== null ? `${memPercent.toFixed(0)}%` : null,
      capacity: memCapacity,
      capacityBytes: totalMemBytes
    },
    {
      key: "disk",
      label: "Disk",
      percent: diskPercent,
      used: diskPercent !== null ? `${diskPercent.toFixed(0)}%` : null,
      capacity: diskCapacity,
      capacityBytes: diskTotalBytes
    }
  ];

  const statusCopy =
    effectiveState === "offline"
      ? "Node offline — telemetry is not current."
      : effectiveState === "stale"
        ? "Telemetry stale — values are not current."
        : null;

  return (
    <div className={cn("space-y-3", compact && "space-y-2", className)}>
      {items.map((item) => (
        <UsageBar
          key={item.key}
          item={item}
          thresholds={thresholds[item.key]}
          state={effectiveState}
        />
      ))}
      {statusCopy && <p className="text-xs text-warning-foreground">{statusCopy}</p>}
      {!statusCopy && cpuPercent === null && memPercent === null && diskPercent === null && (
        <p className="text-xs text-text-muted">
          No resource telemetry reported by the agent yet.
        </p>
      )}
    </div>
  );
}

/**
 * Single-row compact resource strip for inventory tables:
 * `47% · 46% · 31%` with per-resource mini-bars, matching the design's
 * "restrained progress/usage indicators" requirement.
 */
export function ResourceUsageStrip({
  cpuPercent,
  memPercent,
  diskPercent,
  telemetryCurrent,
  thresholds,
  className
}: {
  cpuPercent: number | null;
  memPercent: number | null;
  diskPercent: number | null;
  telemetryCurrent: boolean;
  thresholds: ResourceThresholds;
  className?: string;
}): React.JSX.Element {
  if (!telemetryCurrent) {
    return <span className="text-xs text-text-muted">Telemetry stale</span>;
  }
  const rows: Array<{ label: string; percent: number | null; threshold: { warning: number; critical: number } }> = [
    { label: "CPU", percent: cpuPercent, threshold: thresholds.cpu },
    { label: "RAM", percent: memPercent, threshold: thresholds.mem },
    { label: "disk", percent: diskPercent, threshold: thresholds.disk }
  ];
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      {rows.map((r) => {
        const tone = toneFor(r.percent, r.threshold);
        return (
          <div key={r.label} className="flex items-center gap-2">
            <span className="w-8 shrink-0 text-[11px] uppercase tracking-wide text-text-subtle">{r.label}</span>
            <div className="h-1 w-16 overflow-hidden rounded-full bg-surface-raised">
              {r.percent !== null && (
                <div className={cn("h-full rounded-full", BAR_COLORS[tone])} style={{ width: `${Math.min(Math.max(r.percent, 0), 100)}%` }} />
              )}
            </div>
            <span className={cn("w-9 shrink-0 font-mono text-[11px] tabular-nums", r.percent === null ? "text-text-subtle" : TEXT_COLORS[tone])}>
              {r.percent === null ? "—" : `${r.percent.toFixed(0)}%`}
            </span>
          </div>
        );
      })}
    </div>
  );
}
