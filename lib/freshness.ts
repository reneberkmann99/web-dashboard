export type FreshnessState = "live" | "stale" | "unavailable";

/**
 * Humanize an age in seconds the same way everywhere freshness is shown:
 * seconds under a minute, minutes under an hour, then hours. Never expose
 * raw multi-hundred-second counts (design review round 2, §P0-3).
 */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, seconds);
  if (s < 60) return `${Math.floor(s)}s`;
  // Round rather than floor once we're in minutes/hours — "1070s ago" reads
  // as "18m ago" (round(17.83)), not the visually-jarring "17m ago" a floor
  // would give (design review round 2, P0 §3).
  const totalMinutes = Math.round(s / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.round(s / 3600);
  return `${totalHours}h`;
}

export function formatAge(ageSeconds: number): string {
  return `${formatDuration(ageSeconds)} ago`;
}

/** Compact "18m ago" label for a timestamp — the same style as the top-bar freshness pill. */
export function freshnessAgeLabel(iso: string | Date | null | undefined): string {
  if (!iso) return "never";
  const date = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(date.getTime())) return "—";
  return formatAge((Date.now() - date.getTime()) / 1000);
}

export function deriveFreshness(input: {
  ageSeconds: number | null;
  queryError: boolean;
  nodesTotal: number | null;
  nodesOnline: number | null;
}): { state: FreshnessState; label: string } {
  const { ageSeconds, queryError, nodesTotal, nodesOnline } = input;
  const unavailable = queryError || Boolean(nodesTotal && nodesOnline === 0);
  if (unavailable) return { state: "unavailable", label: "agent unavailable" };
  const stale = ageSeconds === null || ageSeconds > 45 || Boolean(nodesTotal !== null && nodesOnline !== null && nodesOnline < nodesTotal);
  if (stale) return { state: "stale", label: `stale${ageSeconds !== null ? ` · ${formatAge(ageSeconds)}` : ""}` };
  return { state: "live", label: `live · ${formatAge(ageSeconds ?? 0)}` };
}
