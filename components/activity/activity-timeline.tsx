"use client";

import { useMemo, useState } from "react";
import { Activity, AlertTriangle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { humanizeAction } from "@/lib/format";
import { StatePanel } from "@/components/ui/state-panel";

export type TimelineEvent = {
  id: string;
  action: string;
  actorEmail: string | null;
  createdAt: string;
  result?: string;
  targetType?: string;
  targetId?: string | null;
  targetLabel?: string | null;
  humanized?: string;
  metadata?: Record<string, unknown> | null;
};

function metadataName(metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata) return null;
  for (const key of ["resourceName", "containerName", "dockerName", "workloadName", "projectName", "nodeName", "clientName", "targetName", "displayName"]) {
    if (typeof metadata[key] === "string" && metadata[key]) return metadata[key] as string;
  }
  return null;
}

export function activityResourceLabel(event: TimelineEvent, explicitName?: string): string | null {
  if (explicitName) return explicitName;
  if (event.targetLabel) return event.targetLabel;
  const name = metadataName(event.metadata);
  if (name) return name;
  if (event.targetId && !/^[0-9a-f-]{24,}$/i.test(event.targetId)) return event.targetId;
  return null;
}

function sentence(event: TimelineEvent, resourceName?: string): string {
  const verb = event.humanized || humanizeAction(event.action);
  const resource = activityResourceLabel(event, resourceName);
  return resource && !verb.toLowerCase().includes(resource.toLowerCase()) ? `${verb} ${resource}` : verb;
}

function dayKey(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toISOString().slice(0, 10);
}

function dayLabel(key: string): string {
  if (key === "unknown") return "Unknown date";
  const date = new Date(`${key}T12:00:00`);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: date.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

function clockTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

function rollupSentence(value: string, count: number): string {
  const match = /^(.*)\s(user|container|workload|node|client|deployment|secret|grant)$/i.exec(value);
  if (!match) return `${value} · ${count} events`;
  return `${match[1]} ${count} ${match[2].toLowerCase()}s`;
}

export type ActivityGroup = { key: string; day: string; events: TimelineEvent[] };

export function groupActivityEvents(events: TimelineEvent[]): ActivityGroup[] {
  const output: ActivityGroup[] = [];
  for (const event of events) {
    const day = dayKey(event.createdAt);
    const key = `${day}:${event.action}:${event.actorEmail ?? "system"}:${event.result ?? ""}`;
    const previous = output[output.length - 1];
    if (previous?.key === key) previous.events.push(event);
    else output.push({ key, day, events: [event] });
  }
  return output;
}

export function activityRollupSentence(event: TimelineEvent, count: number): string {
  return rollupSentence(event.humanized || humanizeAction(event.action), count);
}

export function ActivityTimeline({
  events,
  resourceName,
  onSelect,
  renderAction,
  emptyText = "No activity recorded.",
  loading = false,
  error = null,
  emptyTitle,
  emptyBody
}: {
  events: TimelineEvent[];
  resourceName?: string;
  onSelect?: (event: TimelineEvent) => void;
  renderAction?: (event: TimelineEvent) => React.ReactNode;
  emptyText?: string;
  loading?: boolean;
  error?: string | null;
  emptyTitle?: string;
  emptyBody?: string;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const groups = useMemo(() => groupActivityEvents(events), [events]);

  if (loading) return <div className="h-40 animate-pulse rounded-panel border border-border bg-surface-deck" />;
  if (error) return <StatePanel tone="error" title="Unable to load activity" description={error} />;
  if (events.length === 0) return <StatePanel title={emptyTitle ?? emptyText} description={emptyBody} />;

  let previousDay = "";
  return (
    <ol className="overflow-hidden rounded-panel border border-border bg-surface-deck" aria-label="Operations timeline" data-activity-timeline>
      {groups.map((group) => {
        const first = group.events[0];
        const showDay = group.day !== previousDay;
        previousDay = group.day;
        const failed = first.result === "FAILURE" || /FAILED|FAILURE/.test(first.action);
        const progress = !failed && /DEPLOY|ROLLBACK|REVISION|RELEASE/.test(first.action);
        const isExpanded = expanded.has(group.key);
        const baseSentence = sentence(first, resourceName);
        return (
          <li key={`${group.key}:${first.id}`}>
            {showDay && <div className="sticky top-[52px] z-[4] border-b border-border bg-surface-raised/95 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-text-subtle backdrop-blur">{dayLabel(group.day)}</div>}
            <div className="border-b border-border last:border-b-0">
              <div className="flex w-full items-center gap-2 px-3 transition-colors hover:bg-surface-raised">
                <button type="button" onClick={() => onSelect?.(first)} className={cn("flex min-w-0 flex-1 items-center gap-3 py-2.5 text-left focus:outline-none focus:ring-2 focus:ring-inset focus:ring-focus", !onSelect && "cursor-default")}>
                  <span className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-lg", failed ? "bg-critical/15 text-critical-foreground" : progress ? "bg-selected/70 text-brand" : "bg-surface-raised text-text-muted")}>
                    {progress ? <Loader2 size={14} className="animate-spin" /> : failed ? <AlertTriangle size={14} /> : <Activity size={14} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] text-text">{group.events.length > 1 ? activityRollupSentence(first, group.events.length) : baseSentence}</span>
                    <span className="mt-0.5 block truncate text-xs text-text-muted">{first.actorEmail ?? "System"}</span>
                  </span>
                </button>
                {group.events.length > 1 && (
                  <button type="button" onClick={() => { setExpanded((current) => { const next = new Set(current); if (next.has(group.key)) next.delete(group.key); else next.add(group.key); return next; }); }} className="shrink-0 rounded-control px-2 py-1 text-xs text-text-muted hover:bg-surface-overlay hover:text-text">
                    {isExpanded ? "Collapse" : "Expand"}
                  </button>
                )}
                {renderAction && <span className="shrink-0" data-row-action>{renderAction(first)}</span>}
                <time className="w-12 shrink-0 text-right font-mono text-[11px] tabular-nums text-text-subtle" dateTime={first.createdAt}>{clockTime(first.createdAt)}</time>
              </div>
              {isExpanded && (
                <div className="border-t border-border/70 bg-surface-hull/25 px-4 py-1.5">
                  {group.events.map((event) => (
                    <button key={event.id} type="button" onClick={() => onSelect?.(event)} className="flex w-full items-center gap-3 rounded-control py-1.5 pl-10 text-left text-xs hover:bg-surface-raised">
                      <span className="min-w-0 flex-1 truncate text-text-muted">{sentence(event, resourceName)}</span>
                      <time className="font-mono text-[11px] text-text-subtle">{clockTime(event.createdAt)}</time>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
