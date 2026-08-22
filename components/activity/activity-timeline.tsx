"use client";

import { useMemo, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, Wrench, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { humanizeAction } from "@/lib/format";
import { formatDuration } from "@/lib/freshness";
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
  /** Set by the server when the referenced resource no longer exists — render "Name (deleted)". */
  targetDeleted?: boolean;
  humanized?: string;
  metadata?: Record<string, unknown> | null;
};

function metadataName(metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata) return null;
  for (const key of ["resourceName", "containerName", "dockerName", "workloadName", "projectName", "nodeName", "clientName", "targetName", "displayName", "name"]) {
    if (typeof metadata[key] === "string" && metadata[key]) return metadata[key] as string;
  }
  return null;
}

/**
 * Human display name for the row's subject. Resolved server-side names win
 * (with a "(deleted)" suffix when the resource no longer exists); metadata is
 * only a fallback for events the server didn't resolve. Never falls back to
 * the raw id — a primary Activity row must not leak internal identifiers
 * (design review round 2, §8). Full/raw ids stay available in the row's
 * expandable technical detail.
 */
export function activityResourceLabel(event: TimelineEvent, explicitName?: string): string | null {
  if (explicitName) return explicitName;
  const resolved = event.targetLabel || metadataName(event.metadata);
  if (!resolved) return null;
  return event.targetDeleted ? `${resolved} (deleted)` : resolved;
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
  const match = /^(.*)\s(user|container|workload|node|client|organization|deployment|secret|grant)$/i.exec(value);
  if (!match) return `${value} · ${count} events`;
  return `${match[1]} ${count} ${match[2].toLowerCase() === "client" ? "organization" : match[2].toLowerCase()}s`;
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

function conditionLifecycle(action: string): { lifecycle: "OPENED" | "RESOLVED"; condition: string } | null {
  const match = /^ATTENTION_(OPENED|RESOLVED)_(.+)$/.exec(action);
  return match ? { lifecycle: match[1] as "OPENED" | "RESOLVED", condition: match[2] } : null;
}

/**
 * Collapse an "X went offline" + "X recovered" pair (or any matching
 * ATTENTION_OPENED / ATTENTION_RESOLVED pair for the same resource) into
 * one incident row carrying a duration, instead of two separate lines a
 * reader has to mentally re-associate (design review round 2, §3). Only
 * collapses immediately adjacent entries in the (already newest-first)
 * event list — the resolved event always sorts directly above its open
 * event when nothing else touched that resource in between.
 */
export function pairIncidentEvents(events: TimelineEvent[]): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (let i = 0; i < events.length; i++) {
    const resolvedEvent = events[i];
    const resolvedInfo = conditionLifecycle(resolvedEvent.action);
    const openEvent = events[i + 1];
    const openInfo = openEvent ? conditionLifecycle(openEvent.action) : null;
    if (
      resolvedInfo?.lifecycle === "RESOLVED" &&
      openInfo?.lifecycle === "OPENED" &&
      openInfo.condition === resolvedInfo.condition &&
      resolvedEvent.targetId &&
      resolvedEvent.targetId === openEvent!.targetId
    ) {
      const durationMs = new Date(resolvedEvent.createdAt).getTime() - new Date(openEvent!.createdAt).getTime();
      const verb = resolvedEvent.humanized || humanizeAction(resolvedEvent.action);
      out.push({
        ...resolvedEvent,
        id: `${openEvent!.id}:${resolvedEvent.id}`,
        humanized: durationMs > 0 ? `${verb} after ${formatDuration(durationMs / 1000)}` : verb,
        metadata: { ...(resolvedEvent.metadata ?? {}), pairedOpenEvent: openEvent, pairedResolvedEvent: resolvedEvent }
      });
      i += 1;
      continue;
    }
    out.push(resolvedEvent);
  }
  return out;
}

type Tone = "positive" | "negative" | "caution" | "neutral";

/** Icon + tone by severity — every row must not render the same neutral pulse glyph (§3). */
function eventTone(event: TimelineEvent): Tone {
  const action = event.action.toUpperCase();
  if (event.result === "FAILURE" || /_FAILED$|CRASH_LOOP|OFFLINE(?!.*RESOLVED)/.test(action)) {
    if (/^ATTENTION_RESOLVED_/.test(action)) return "positive";
    return "negative";
  }
  if (/^ATTENTION_RESOLVED_|_RECOVERED$|_SUCCEEDED$/.test(action) || action === "LOGIN_SUCCESS") return "positive";
  if (/^ATTENTION_OPENED_|DEGRADED|DRIFT|UNHEALTHY|STUCK/.test(action)) return "negative";
  if (/MAINTENANCE/.test(action)) return "caution";
  return "neutral";
}

const TONE_ICON: Record<Tone, React.ComponentType<{ size?: number; className?: string }>> = {
  positive: CheckCircle2,
  negative: AlertTriangle,
  caution: Wrench,
  neutral: Activity
};

const TONE_CLASS: Record<Tone, string> = {
  positive: "bg-success/15 text-success-foreground",
  negative: "bg-critical/15 text-critical-foreground",
  caution: "bg-warning/15 text-warning-foreground",
  neutral: "bg-surface-raised text-text-muted"
};

/** A real person acted — system-driven rows omit the actor line entirely rather than printing "System" (§9). */
function personActor(event: TimelineEvent): string | null {
  if (!event.actorEmail) return null;
  return event.actorEmail;
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
  emptyBody,
  pairIncidents = true
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
  /** Collapse open/close attention pairs into one incident row. Off for scoped feeds that need every raw record (e.g. a single resource's full history). */
  pairIncidents?: boolean;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const paired = useMemo(() => (pairIncidents ? pairIncidentEvents(events) : events), [events, pairIncidents]);
  const groups = useMemo(() => groupActivityEvents(paired), [paired]);

  if (loading) return <div className="h-40 animate-pulse rounded-panel border border-border bg-surface-deck" />;
  if (error) return <StatePanel tone="error" title="Unable to load activity" description={error} />;
  if (events.length === 0) return <StatePanel title={emptyTitle ?? emptyText} description={emptyBody} />;

  let previousDay = "";
  return (
    // `overflow-hidden` (any non-`visible` overflow) makes this element a
    // scroll container per the CSS Overflow spec, which becomes the sticky
    // day header's containing block — its `top:52px` then resolves against
    // THIS box's top instead of the page's, pushing the header ~52px past
    // its correct position and overlapping the row above it. `md:overflow-visible`
    // removes that scroll-container status on desktop, where the sticky
    // header actually needs to clear the page's fixed topbar (round 2 P0 §1).
    <ol className="overflow-hidden rounded-panel border border-border bg-surface-deck md:overflow-visible" aria-label="Operations timeline" data-activity-timeline>
      {groups.map((group) => {
        const first = group.events[0];
        const showDay = group.day !== previousDay;
        previousDay = group.day;
        const tone = eventTone(first);
        const Icon = TONE_ICON[tone];
        const isExpanded = expanded.has(group.key);
        const baseSentence = sentence(first, resourceName);
        const resource = !resourceName ? activityResourceLabel(first) : null;
        const actor = personActor(first);
        return (
          <li key={`${group.key}:${first.id}`}>
            {showDay && (
              <div className="sticky top-[52px] z-[2] border-b border-border bg-surface-raised px-4 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-text-subtle">
                {dayLabel(group.day)}
              </div>
            )}
            <div className="border-b border-border last:border-b-0">
              <div className="flex w-full items-center gap-2 px-3 transition-colors hover:bg-surface-raised">
                <button type="button" onClick={() => onSelect?.(first)} className={cn("flex min-w-0 flex-1 items-center gap-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus", !onSelect && "cursor-default")}>
                  <span className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-lg", TONE_CLASS[tone])}>
                    <Icon size={14} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] text-text">{group.events.length > 1 ? activityRollupSentence(first, group.events.length) : baseSentence}</span>
                    <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-text-muted">
                      {resource && <span className="truncate">{resource}</span>}
                      {resource && actor && <span className="text-text-subtle">·</span>}
                      {actor && (
                        <span className="flex shrink-0 items-center gap-1 truncate">
                          <User size={11} className="shrink-0" />
                          {actor}
                        </span>
                      )}
                    </span>
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
