"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Loader2, PlayCircle } from "lucide-react";
import { apiFetch } from "@/lib/fetcher";
import { Badge } from "@/components/ui/badge";
import { AttentionBadge } from "@/components/ui/attention-badge";
import { MetricCard } from "@/components/ui/metric-card";
import { timeAgo, humanizeAction } from "@/lib/format";
import type { AttentionItem, WorkloadSummary, FleetSummary, RecentFailure, ActiveOperationSummary } from "@/types/domain";

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
  }>;
  attention: AttentionItem[];
  workloads: WorkloadSummary[];
  recentActivity: Array<{ id: string; action: string; humanized: string; actorEmail: string | null; result: string; createdAt: string }>;
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
  const query = useQuery({
    queryKey: ["admin-overview"],
    queryFn: () => apiFetch<OverviewPayload>("/api/admin/overview"),
    refetchInterval: 20000
  });

  if (query.isLoading) {
    return (
      <div className="space-y-6">
        <div className="h-10 w-64 animate-pulse rounded bg-panelAlt" />
        <div className="grid gap-4 md:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-lg bg-panelAlt" />
          ))}
        </div>
      </div>
    );
  }

  if (query.isError || !query.data) {
    return (
      <div className="rounded-lg border border-danger/30 bg-danger/5 p-8 text-center">
        <p className="text-sm text-red-300">Failed to load the dashboard.</p>
        <p className="mt-1 text-xs text-muted">{query.error instanceof Error ? query.error.message : ""}</p>
      </div>
    );
  }

  const { fleetSummary, nodes, attention, workloads, recentActivity, recentFailures, activeOperations } = query.data;
  const unexpectedAttention = attention.filter((item) => !item.maintenance);
  const maintenanceAttention = attention.filter((item) => item.maintenance);
  const attentionVisible = unexpectedAttention.length > 0;

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
          {item.acknowledgement && <p className="text-cyan-200">Acknowledged by {item.acknowledgement.acknowledgedBy} · {timeAgo(item.acknowledgement.acknowledgedAt)}</p>}
          {item.silence && <p>Notifications silenced until {new Date(item.silence.endsAt).toLocaleString()}</p>}
          {item.maintenance && <p className="text-amber-200">Maintenance until {new Date(item.maintenance.endsAt).toLocaleString()}</p>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <AttentionBadge severity={item.severity} />
        {item.href && <ArrowRight size={14} className="text-muted" />}
      </div>
    </button>
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Overview</h1>
        <p className="text-muted">Operational state of your fleet — and what requires attention.</p>
      </div>

      {/* Fleet summary (§2) — concise counters, never a Grafana clone */}
      <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-5">
        <MetricCard
          label="Nodes"
          value={`${fleetSummary.nodesOnline}/${fleetSummary.nodesTotal}`}
          sub={fleetSummary.nodesOnline === fleetSummary.nodesTotal ? "all online" : "need attention"}
        />
        <MetricCard
          label="Workloads"
          value={`${fleetSummary.workloadsHealthy}/${fleetSummary.workloadsTotal}`}
          sub={fleetSummary.degradedWorkloads > 0 ? `${fleetSummary.degradedWorkloads} degraded` : "all healthy"}
        />
        <MetricCard
          label="Containers"
          value={`${fleetSummary.containersRunning}/${fleetSummary.containersTotal}`}
          sub={fleetSummary.unhealthyContainers > 0 ? `${fleetSummary.unhealthyContainers} unhealthy` : "running"}
        />
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
        <h2 className="mb-2 text-lg font-semibold text-amber-300">Needs attention</h2>
        {!attentionVisible ? (
          <div className="rounded-lg border border-border bg-panelAlt/40 p-4 text-sm text-muted">
            No unexpected active issues. All {fleetSummary.nodesTotal} node{fleetSummary.nodesTotal === 1 ? "" : "s"} and{" "}
            {fleetSummary.workloadsTotal} workload{fleetSummary.workloadsTotal === 1 ? "" : "s"} are operating normally.
          </div>
        ) : (
          <div className="space-y-2">
            {unexpectedAttention.map(renderAttentionCard)}
          </div>
        )}
      </section>

      {maintenanceAttention.length > 0 && (
        <section aria-label="Under maintenance">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-amber-200">Under maintenance</h2>
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
              <Link
                key={w.id}
                href={`/admin/workloads/${w.id}`}
                className="rounded-lg border border-border bg-panel p-4 transition hover:border-accent/40"
              >
                <div className="flex items-center justify-between">
                  <p className="font-medium">{w.name}</p>
                  <AttentionBadge severity={w.health === "down" ? "critical" : w.health === "degraded" ? "warning" : w.health} />
                </div>
                <p className="mt-0.5 text-xs text-muted">{w.nodeName}</p>
                <p className="mt-3 text-sm">
                  {w.runningContainers}/{w.totalContainers} containers running
                </p>
                {(w.cpuPercent !== null || w.memoryUsage) && (
                  <p className="mt-1 text-xs text-muted">
                    {w.cpuPercent !== null ? `${w.cpuPercent}% CPU` : ""}
                    {w.cpuPercent !== null && w.memoryUsage ? " · " : ""}
                    {w.memoryUsage ?? ""}
                  </p>
                )}
              </Link>
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
            <Link
              key={node.id}
              href={`/admin/nodes/${node.id}`}
              className="rounded-lg border border-border bg-panel p-4 transition hover:border-accent/40"
            >
              <div className="flex items-center justify-between">
                <p className="font-medium">{node.name}</p>
                <Badge
                  variant={node.offline ? "danger" : node.staleHeartbeat ? "warning" : "success"}
                >
                  {node.offline ? "offline" : node.staleHeartbeat ? "stale" : "online"}
                </Badge>
              </div>
              <p className="mt-0.5 text-xs text-muted">
                {node.containerCount} containers · heartbeat {timeAgo(node.lastHeartbeatAt)}
              </p>
            </Link>
          ))}
        </div>
      </section>

      {/* Recent failures (§13) — operational, distinct from full Activity audit log */}
      {recentFailures.length > 0 && (
        <section>
          <h2 className="mb-2 text-lg font-semibold">Recent failures</h2>
          <div className="rounded-lg border border-border bg-panel">
            <ul className="divide-y divide-border">
              {recentFailures.slice(0, 8).map((f) => (
                <li key={f.id}>
                  <button
                    type="button"
                    onClick={() => f.href && router.push(f.href)}
                    className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-sm hover:bg-panelAlt/60"
                  >
                    <span>
                      {f.title}
                      {f.detail && <span className="ml-2 text-xs text-muted">{f.detail}</span>}
                    </span>
                    <span className="shrink-0 text-xs text-muted">{timeAgo(f.createdAt)}</span>
                  </button>
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
        <div className="rounded-lg border border-border bg-panel">
          {recentActivity.length === 0 ? (
            <p className="p-4 text-sm text-muted">No activity yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {recentActivity.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                  <span>
                    {a.humanized}
                    <span className="ml-2 text-xs text-muted">{a.actorEmail ?? "system"}</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted">{timeAgo(a.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
