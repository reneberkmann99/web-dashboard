"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Loader2, PlayCircle, Server, X } from "lucide-react";
import { apiFetch } from "@/lib/fetcher";
import { Badge } from "@/components/ui/badge";
import { AttentionBadge } from "@/components/ui/attention-badge";
import { MetricCard } from "@/components/ui/metric-card";
import { PageHeader } from "@/components/ui/page-header";
import { StatePanel } from "@/components/ui/state-panel";
import { ResourceUsage } from "@/components/ui/resource-usage";
import { timeAgo, humanizeAction } from "@/lib/format";
import { useResourceNavigation } from "@/components/navigation/navigation-context";
import { MobileAdminOverview } from "@/components/mobile/mobile-overview";
import { ActivityTimeline } from "@/components/activity/activity-timeline";
import type { AttentionItem, WorkloadSummary, FleetSummary, RecentFailure, ActiveOperationSummary, ResourceThresholds } from "@/types/domain";

type OverviewPayload = {
  utilization: {
    cpuPercent: number | null;
    memoryUsage: string | null;
    totalContainers: number;
    runningContainers: number;
    stoppedContainers: number;
    unhealthyContainers: number;
    restartingContainers: number;
  };
  fleetSummary: FleetSummary;
  nodes: Array<{
    id: string;
    name: string;
    status: string;
    isActive: boolean;
    lastHeartbeatAt: string | null;
    offline: boolean;
    staleHeartbeat: boolean;
    containerCount: number;
    telemetryCurrent: boolean;
    systemInfo: Record<string, unknown> | null;
  }>;
  resourceThresholds: ResourceThresholds;
  attention: AttentionItem[];
  workloads: WorkloadSummary[];
  recentActivity: Array<{ id: string; action: string; humanized: string; actorEmail: string | null; result: string; createdAt: string; targetLabel: string | null }>;
  recentFailures: RecentFailure[];
  activeOperations: ActiveOperationSummary[];
};

/**
 * Fleet operations home screen (Phase 6D). The goal: within a few seconds an
 * administrator can answer "are all nodes reachable, are workloads healthy,
 * is anything degraded/restarting, did something fail recently, is a
 * deployment happening, which problem should I look at first" — without
 * manually inspecting every container. Normal healthy state stays quiet
 * (§29); Needs attention is the most important section and is deduplicated
 * server-side (server/services/attention.ts), not recomputed here.
 */
export default function AdminOverviewPage(): React.JSX.Element {
  const router = useRouter();
  const go = useResourceNavigation();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["admin-overview"],
    queryFn: () => apiFetch<OverviewPayload>("/api/admin/overview"),
    refetchInterval: 20000
  });

  const dismissFailure = useMutation({
    mutationFn: (key: string) =>
      apiFetch("/api/admin/recent-failures/dismiss", {
        method: "POST",
        body: JSON.stringify({ key })
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-overview"] })
  });
  const dismissAllFailures = useMutation({
    mutationFn: () =>
      apiFetch("/api/admin/recent-failures/dismiss", {
        method: "POST",
        body: JSON.stringify({ all: true })
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-overview"] })
  });

  if (query.isLoading) {
    return (
      <div className="space-y-6">
        <div className="h-10 w-64 animate-pulse rounded-control bg-surface-raised" />
        <div className="flex gap-2.5 overflow-hidden md:grid md:grid-cols-5 md:gap-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-24 w-[112px] flex-none animate-pulse rounded-panel bg-surface-raised md:w-auto" />
          ))}
        </div>
      </div>
    );
  }

  if (query.isError || !query.data) {
    return (
      <StatePanel tone="error" title="Failed to load the dashboard" description={query.error instanceof Error ? query.error.message : undefined} />
    );
  }

  const { fleetSummary, nodes, attention, workloads, recentActivity, recentFailures, activeOperations, resourceThresholds } = query.data;
  const unexpectedAttention = attention.filter((item) => !item.maintenance);
  const maintenanceAttention = attention.filter((item) => item.maintenance);
  const attentionVisible = unexpectedAttention.length > 0;
  const fleetNominal = fleetSummary.attentionIssues === 0 && fleetSummary.nodesOnline === fleetSummary.nodesTotal;

  const renderAttentionCard = (item: AttentionItem): React.JSX.Element => (
    <button
      key={item.id}
      type="button"
      onClick={() => item.href && router.push(item.href)}
      className={`flex w-full items-start justify-between gap-3 rounded-lg border p-3 text-left transition ${
        item.href ? "cursor-pointer hover:border-accent/40" : "cursor-default"
      } ${item.acknowledgement && item.severity !== "critical" ? "opacity-80" : ""} ${
        item.severity === "critical"
          ? "border-danger/30 bg-danger/5"
          : item.severity === "warning"
            ? "border-warning/30 bg-warning/5"
            : "border-border bg-panelAlt/60"
      }`}
    >
      <div>
        <p className="text-sm font-medium">{item.title}</p>
        <p className="text-xs text-muted">{item.detail}</p>
        <div className="mt-1 space-y-0.5 text-xs text-muted">
          {item.acknowledgement && <p className="text-info-foreground">Acknowledged by {item.acknowledgement.acknowledgedBy} · {timeAgo(item.acknowledgement.acknowledgedAt)}</p>}
          {item.silence && <p>Notifications silenced until {new Date(item.silence.endsAt).toLocaleString()}</p>}
          {item.maintenance && <p className="text-warning-foreground">Maintenance until {new Date(item.maintenance.endsAt).toLocaleString()}</p>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <AttentionBadge severity={item.severity} />
        {item.href && <ArrowRight size={14} className="text-muted" />}
      </div>
    </button>
  );

  return (
    <>
      <div className="md:hidden">
        <MobileAdminOverview data={query.data} />
      </div>
      <div className="hidden space-y-5 md:block">
      <PageHeader
        eyebrow="Fleet"
        title="Overview"
        description={
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span className="text-text-muted">Operational state of your fleet — and what requires attention.</span>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[11px] ${
                fleetNominal ? "border-border bg-surface-raised/60 text-success-foreground" : "border-warning/30 bg-warning/5 text-warning-foreground"
              }`}
              title="Fleet-wide status from the last telemetry poll"
            >
              <span className={`h-1.5 w-1.5 rounded-full ${fleetNominal ? "bg-success" : "bg-warning"}`} />
              {fleetNominal ? "fleet nominal" : `${fleetSummary.attentionIssues} issue${fleetSummary.attentionIssues === 1 ? "" : "s"}`}
            </span>
          </div>
        }
      />

      {/* Fleet summary (§2) — concise counters, never a Grafana clone */}
      <div className="grid gap-4 xl:grid-cols-[2fr_1fr_1fr]">
        <div className="rounded-panel border border-border bg-surface-deck p-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-subtle">Fleet</p>
          <div className="mt-3 grid grid-cols-3 divide-x divide-border">
            <div className="pr-4"><p className="font-mono text-[11px] uppercase tracking-[0.12em] text-text-muted">Nodes</p><p className="mt-2 font-mono text-2xl font-medium tabular-nums">{fleetSummary.nodesOnline}<span className="text-text-subtle">/{fleetSummary.nodesTotal}</span></p></div>
            <div className="px-4"><p className="font-mono text-[11px] uppercase tracking-[0.12em] text-text-muted">Workloads</p><p className="mt-2 font-mono text-2xl font-medium tabular-nums">{fleetSummary.workloadsHealthy}<span className="text-text-subtle">/{fleetSummary.workloadsTotal}</span></p></div>
            <div className="pl-4"><p className="font-mono text-[11px] uppercase tracking-[0.12em] text-text-muted">Containers</p><p className="mt-2 font-mono text-2xl font-medium tabular-nums">{fleetSummary.containersRunning}<span className="text-text-subtle">/{fleetSummary.containersTotal}</span></p></div>
          </div>
        </div>
        <MetricCard
          icon={AlertTriangle}
          label="Attention"
          value={String(fleetSummary.attentionIssues)}
          sub={fleetSummary.attentionIssues === 0 ? "no active issues" : `issue${fleetSummary.attentionIssues === 1 ? "" : "s"}`}
        />
        <MetricCard
          icon={fleetSummary.activeOperations > 0 ? Loader2 : PlayCircle}
          label="Operations"
          value={String(fleetSummary.activeOperations)}
          sub={fleetSummary.activeOperations > 0 ? "active now" : "none active"}
        />
      </div>

      {/* Needs attention — the most important section, deduplicated server-side (§3/§4) */}
      <section aria-label="Needs attention">
        <h2 className="mb-2 text-lg font-semibold">Needs attention</h2>
        {!attentionVisible ? (
          <StatePanel compact tone="success" title="Nothing needs you." description={`All ${fleetSummary.nodesTotal} node${fleetSummary.nodesTotal === 1 ? "" : "s"} and ${fleetSummary.workloadsTotal} workload${fleetSummary.workloadsTotal === 1 ? "" : "s"} are operating normally.`} action={<Link href="/admin/attention?view=resolved" className="text-sm text-brand">Resolved history →</Link>} />
        ) : (
          <div className="space-y-2">
            {unexpectedAttention.map(renderAttentionCard)}
          </div>
        )}
      </section>

      {maintenanceAttention.length > 0 && (
        <section aria-label="Under maintenance">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-warning-foreground">Under maintenance</h2>
            <Link href="/admin/attention?maintenance=active" className="text-sm text-accent hover:underline">View in Attention</Link>
          </div>
          <div className="space-y-2">{maintenanceAttention.map(renderAttentionCard)}</div>
        </section>
      )}

      {/* Active operations (§12) */}
      {activeOperations.length > 0 && (
        <section>
          <h2 className="mb-2 text-lg font-semibold">Active operations</h2>
          <div className="rounded-lg border border-border bg-panel">
            <ul className="divide-y divide-border">
              {activeOperations.map((op) => (
                <li key={op.id}>
                  <button
                    type="button"
                    onClick={() => op.targetHref && router.push(op.targetHref)}
                    className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-sm hover:bg-panelAlt/60"
                  >
                    <span className="flex items-center gap-2">
                      <Loader2 size={13} className="animate-spin text-accent" />
                      {humanizeAction(op.type)} — {op.targetName}
                    </span>
                    <span className="flex items-center gap-2 text-xs text-muted">
                      {op.actorEmail ?? "system"} · {op.state.toLowerCase()}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {/* Fleet Resources — real per-node telemetry (CPU/RAM/disk). */}
      <section aria-label="Fleet resources">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Fleet resources</h2>
          <Link href="/admin/nodes" className="inline-flex items-center gap-1 text-sm text-accent hover:underline">
            Manage <ArrowRight size={14} />
          </Link>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {nodes.map((node) => {
            const sys = (node.systemInfo ?? {}) as Record<string, unknown>;
            return (
              <a
                key={node.id}
                href={`/admin/nodes/${node.id}`}
                onClick={(event) => {
                  event.preventDefault();
                  go({ url: `/admin/nodes/${node.id}`, label: node.name, type: "node", id: node.id });
                }}
                className="cursor-pointer rounded-panel border border-border bg-surface-deck p-4 transition-colors hover:border-selected-border/40"
              >
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-surface-raised">
                      <Server size={13} className="text-text-muted" />
                    </span>
                    <span className="truncate font-medium">{node.name}</span>
                  </div>
                  <Badge variant={node.offline ? "danger" : node.staleHeartbeat ? "warning" : "success"}>
                    {node.offline ? "offline" : node.staleHeartbeat ? "stale" : "online"}
                  </Badge>
                </div>
                <ResourceUsage
                  cpuPercent={typeof sys.cpuPercent === "number" ? sys.cpuPercent : null}
                  memPercent={typeof sys.memPercent === "number" ? sys.memPercent : null}
                  diskPercent={typeof sys.diskPercent === "number" ? sys.diskPercent : null}
                  diskTotalBytes={typeof sys.diskTotalBytes === "number" ? sys.diskTotalBytes : null}
                  diskFreeBytes={typeof sys.diskFreeBytes === "number" ? sys.diskFreeBytes : null}
                  totalMemBytes={typeof sys.totalMemBytes === "number" ? sys.totalMemBytes : null}
                  cpuCount={typeof sys.cpuCount === "number" ? sys.cpuCount : null}
                  telemetryCurrent={node.telemetryCurrent && !node.offline && !node.staleHeartbeat}
                  state={node.offline ? "offline" : node.staleHeartbeat ? "stale" : "current"}
                  thresholds={resourceThresholds}
                  compact
                />
                <p className="mt-2 font-mono text-[11px] text-text-subtle">
                  {node.containerCount} containers · heartbeat {timeAgo(node.lastHeartbeatAt)}
                </p>
              </a>
            );
          })}
        </div>
      </section>

      {/* Workloads */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Workloads</h2>
          <Link
            href="/admin/workloads"
            className="inline-flex items-center gap-1 text-sm text-accent hover:underline"
          >
            View all <ArrowRight size={14} />
          </Link>
        </div>
        {workloads.length === 0 ? (
          <p className="text-sm text-muted">No workloads yet — group containers into stacks to get started.</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {workloads.slice(0, 9).map((w) => (
              <a
                key={w.id}
                href={`/admin/workloads/${w.id}`}
                onClick={(event) => {
                  event.preventDefault();
                  go({ url: `/admin/workloads/${w.id}`, label: w.name, type: "workload", id: w.id });
                }}
                className="cursor-pointer rounded-panel border border-border bg-surface-deck p-4 transition-colors hover:border-selected-border/40"
              >
                <div className="flex items-center justify-between">
                  <p className="font-medium">{w.name}</p>
                  <AttentionBadge severity={w.health === "down" ? "critical" : w.health === "degraded" ? "warning" : w.health} />
                </div>
                <p className="mt-0.5 font-mono text-[11px] text-text-muted">{w.nodeName}</p>
                <p className="mt-3 font-mono text-sm">
                  {w.runningContainers}/{w.totalContainers} running
                  {w.intentionallyStoppedContainers > 0 && (
                    <span className="text-text-muted"> · {w.intentionallyStoppedContainers} intentionally stopped</span>
                  )}
                </p>
                {(w.cpuPercent !== null || w.memoryUsage) && (
                  <p className="mt-1 font-mono text-[11px] text-text-muted">
                    {w.cpuPercent !== null ? `${w.cpuPercent}% CPU` : ""}
                    {w.cpuPercent !== null && w.memoryUsage ? " · " : ""}
                    {w.memoryUsage ?? ""}
                  </p>
                )}
              </a>
            ))}
          </div>
        )}
      </section>

      {/* Nodes */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Nodes</h2>
          <Link href="/admin/nodes" className="inline-flex items-center gap-1 text-sm text-accent hover:underline">
            Manage <ArrowRight size={14} />
          </Link>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {nodes.map((node) => (
            <a
              key={node.id}
              href={`/admin/nodes/${node.id}`}
              onClick={(event) => {
                event.preventDefault();
                go({ url: `/admin/nodes/${node.id}`, label: node.name, type: "node", id: node.id });
              }}
              className="flex cursor-pointer items-center gap-3 rounded-panel border border-border bg-surface-deck p-4 transition-colors hover:border-selected-border/40"
            >
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[0.625rem] bg-surface-raised">
                <Server size={16} className="text-text-muted" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <p className="truncate font-medium">{node.name}</p>
                  <Badge variant={node.offline ? "danger" : node.staleHeartbeat ? "warning" : "success"}>
                    {node.offline ? "offline" : node.staleHeartbeat ? "stale" : "online"}
                  </Badge>
                </div>
                <p className="mt-0.5 font-mono text-xs text-text-muted">
                  {node.containerCount} containers · heartbeat {timeAgo(node.lastHeartbeatAt)}
                </p>
              </div>
            </a>
          ))}
        </div>
      </section>

      {/* Recent failures (§13) — grouped, recency-windowed, dismissible (UI-only) */}
      {recentFailures.length > 0 && (
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Recent failures</h2>
            <button
              type="button"
              onClick={() => dismissAllFailures.mutate()}
              disabled={dismissAllFailures.isPending}
              className="text-sm text-accent hover:underline disabled:opacity-50"
            >
              Dismiss all
            </button>
          </div>
          <div className="rounded-lg border border-border bg-panel">
            <ul className="divide-y divide-border">
              {recentFailures.slice(0, 8).map((f) => (
                <li key={f.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-medium">{f.title}</span>
                      {f.attempts > 1 && <span className="font-mono text-xs text-muted">{f.attempts} attempts</span>}
                    </div>
                    {f.detail && <p className="truncate text-xs text-muted">{f.detail}</p>}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {f.href && (
                      <button type="button" onClick={() => f.href && router.push(f.href)} className="text-xs text-accent hover:underline">
                        View details
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => dismissFailure.mutate(f.id)}
                      disabled={dismissFailure.isPending}
                      aria-label={`Dismiss ${f.title}`}
                      className="text-xs text-muted hover:text-text disabled:opacity-50"
                    >
                      <X size={13} />
                    </button>
                    <span className="shrink-0 font-mono text-xs text-muted">{timeAgo(f.createdAt)}</span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {/* Recent activity */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Recent activity</h2>
          <Link href="/admin/activity" className="inline-flex items-center gap-1 text-sm text-accent hover:underline">
            View all <ArrowRight size={14} />
          </Link>
        </div>
        <ActivityTimeline events={recentActivity} emptyTitle="No activity yet" emptyBody="Operator and system changes will appear here." />
      </section>
      </div>
    </>
  );
}
