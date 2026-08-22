"use client";

import { useMemo, useState } from "react";
import {
  Activity as ActivityIcon,
  Boxes,
  KeyRound,
  LogIn,
  LogOut,
  Rocket,
  RotateCw,
  Server,
  ShieldX,
  UserMinus,
  UserPlus,
  Users,
  Workflow,
  type LucideIcon
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { humanizeAction, timeAgo } from "@/lib/format";

/**
 * Mobile Activity list (design §05) — grouped by day, one dense line per
 * event: icon tile, humanized action (+ mono target), actor · resource,
 * relative time on the right. Consecutive identical events collapse into a
 * "×N more …" row with Expand. Replaces the desktop timeline below `md`.
 */

export type MobileActivityEvent = {
  id: string;
  action: string;
  actorEmail: string | null;
  createdAt: string;
  result?: string;
  targetType?: string;
  targetId?: string | null;
  targetLabel?: string | null;
  metadata?: Record<string, unknown> | null;
};

function eventIcon(action: string): { icon: LucideIcon; tone: "default" | "danger" } {
  const a = action.toUpperCase();
  if (a.includes("LOGIN_FAILED") || a.includes("FAIL")) return { icon: ShieldX, tone: "danger" };
  if (a.startsWith("LOGIN")) return { icon: LogIn, tone: "default" };
  if (a.includes("LOGOUT") || a.includes("SIGN_OUT")) return { icon: LogOut, tone: "default" };
  if (a.includes("CONTAINER_RESTART") || a.includes("RESTART")) return { icon: RotateCw, tone: "default" };
  if (a.includes("CONTAINER_START")) return { icon: ActivityIcon, tone: "default" };
  if (a.includes("CONTAINER_STOP")) return { icon: ActivityIcon, tone: "default" };
  if (a.startsWith("USER_")) return { icon: a.includes("CREATE") || a.includes("ACTIVATE") || a.includes("REINVITE") ? UserPlus : UserMinus, tone: "default" };
  if (a.startsWith("NODE_")) return { icon: Server, tone: "default" };
  if (a.includes("CLIENT_")) return { icon: Users, tone: "default" };
  if (a.includes("DEPLOY") || a.includes("ROLLBACK") || a.includes("REVISION") || a.includes("SECRET")) return { icon: Rocket, tone: "default" };
  if (a.includes("GRANT") || a.includes("ASSIGNMENT")) return { icon: KeyRound, tone: "default" };
  if (a.includes("WORKLOAD") || a.includes("PROJECT")) return { icon: Boxes, tone: "default" };
  return { icon: Workflow, tone: "default" };
}

function metadataName(metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata) return null;
  for (const key of ["resourceName", "containerName", "dockerName", "workloadName", "projectName", "nodeName", "clientName", "targetName"]) {
    if (typeof metadata[key] === "string" && metadata[key]) return metadata[key] as string;
  }
  return null;
}

function groupLabel(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayMs = 86_400_000;
  if (startOfDay === startOfToday) return "Today";
  if (startOfDay === startOfToday - dayMs) return "Yesterday";
  return date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
}

function rightTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (date.getTime() >= startOfToday) return timeAgo(date);
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function pluralize(action: string, count: number): string {
  const base = humanizeAction(action);
  // "Restarted container" → "restarts" style summaries
  const lower = base.toLowerCase();
  if (lower.endsWith(" container")) return `${count} more container${count > 1 ? "s" : ""}`;
  if (lower.endsWith(" user")) return `${count} more user${count > 1 ? "s" : ""}`;
  if (lower.endsWith(" client")) return `${count} more organization${count > 1 ? "s" : ""}`;
  return `${count} more ${lower.replace(/^(created|deleted|updated|started|stopped|restarted|revoked|granted|activated|deactivated|reissued|registered|adopted|converted|detached|enrolled)\s+/, "")}`;
}

export function MobileActivityList({
  events,
  onSelect,
  renderAction,
  resourceName,
  emptyText = "No activity recorded."
}: {
  events: MobileActivityEvent[];
  onSelect?: (event: MobileActivityEvent) => void;
  renderAction?: (event: MobileActivityEvent) => React.ReactNode;
  resourceName?: string;
  emptyText?: string;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const groups = useMemo(() => {
    const ordered = [...events].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const out: Array<{ label: string; rows: Array<{ event: MobileActivityEvent; collapsed: number }> }> = [];
    for (const event of ordered) {
      const label = groupLabel(event.createdAt);
      let group = out.find((g) => g.label === label);
      if (!group) {
        group = { label, rows: [] };
        out.push(group);
      }
      const prev = group.rows[group.rows.length - 1];
      const sameRun =
        prev &&
        !prev.event.result &&
        !event.result &&
        prev.event.action === event.action &&
        prev.event.targetLabel === (event.targetLabel ?? null);
      if (sameRun && !expanded.has(event.id)) {
        prev.collapsed += 1;
        continue;
      }
      group.rows.push({ event, collapsed: 0 });
    }
    return out;
  }, [events, expanded]);

  if (events.length === 0) {
    return (
      <div className="rounded-panel border border-border bg-surface-deck p-5 text-sm text-text-muted">
        {emptyText}
      </div>
    );
  }

  return (
    <div aria-label="Operations timeline">
      {groups.map((group) => (
        <section key={group.label} className="pt-1">
          <p className="px-4 pb-2 pt-3 font-mono text-[10px] uppercase tracking-[0.16em] text-text-subtle">
            {group.label}
          </p>
          <div className="border-t border-border/60">
            {group.rows.map(({ event, collapsed }) => {
              const { icon: Icon, tone } = eventIcon(event.action);
              const target = event.targetLabel ?? metadataName(event.metadata) ?? resourceName;
              const row = (
                <div className="flex gap-3 px-4 py-[13px]">
                  <span
                    className={cn(
                      "grid h-[30px] w-[30px] flex-none place-items-center rounded-[9px]",
                      tone === "danger" ? "bg-critical/14" : "bg-surface-raised"
                    )}
                  >
                    <Icon size={15} className={tone === "danger" ? "text-critical-foreground" : "text-success-foreground"} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[14.5px] leading-5 text-text">
                      {humanizeAction(event.action)}
                      {target && <span className="ml-1.5 font-mono text-[13px] text-text-muted">{target}</span>}
                      {event.result === "FAILURE" && (
                        <span className="ml-1.5 inline-flex items-center rounded-[5px] bg-critical/18 px-1.5 py-px text-[11px] text-critical-foreground">
                          failed
                        </span>
                      )}
                    </p>
                    <p className="mt-0.5 truncate font-mono text-[11px] text-text-muted">
                      {event.actorEmail ?? "System"}
                      {target && event.actorEmail ? " · " : ""}
                    </p>
                  </div>
                  <span className="flex-none pt-0.5 font-mono text-[11px] text-text-subtle">{rightTime(event.createdAt)}</span>
                </div>
              );
              return (
                <div key={event.id} className="border-b border-border/60">
                  {collapsed > 0 && (
                    <button
                      type="button"
                      onClick={() => setExpanded((prev) => new Set(prev).add(event.id))}
                      className="flex w-full items-center gap-3 px-4 py-[13px] text-left focus:outline-none focus:ring-2 focus:ring-inset focus:ring-focus"
                    >
                      <span className="grid h-[30px] w-[30px] flex-none place-items-center rounded-[9px] bg-surface-raised font-mono text-[11px] text-text-muted">
                        ×{collapsed + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-[14.5px] text-text">{pluralize(event.action, collapsed)}</p>
                        <p className="mt-0.5 text-[11px] text-brand-hover">Expand</p>
                      </div>
                      <span className="flex-none pt-0.5 font-mono text-[11px] text-text-subtle">{rightTime(event.createdAt)}</span>
                    </button>
                  )}
                  {onSelect ? (
                    <button
                      type="button"
                      onClick={() => onSelect(event)}
                      className="w-full text-left focus:outline-none focus:ring-2 focus:ring-inset focus:ring-focus"
                    >
                      {row}
                    </button>
                  ) : (
                    row
                  )}
                  {renderAction && (
                    <div className="flex justify-end px-4 pb-2" data-row-action>
                      {renderAction(event)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

export { Badge };
