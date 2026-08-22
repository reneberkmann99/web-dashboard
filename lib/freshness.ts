export type FreshnessState = "live" | "stale" | "unavailable";

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
  if (stale) return { state: "stale", label: `stale${ageSeconds !== null ? ` · ${ageSeconds}s ago` : ""}` };
  return { state: "live", label: `live · ${ageSeconds ?? 0}s ago` };
}
