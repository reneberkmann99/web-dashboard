"use client";

import { useRouter } from "next/navigation";
import { ArrowRight, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AttentionItem, WorkloadSummary, ResourceThresholds } from "@/types/domain";
import { timeAgo } from "@/lib/format";
import { MobileMetricCard, MobileMetricStrip, CardChip } from "@/components/mobile/mobile-resource-card";
import { containerCard, nodeCard, workloadCard } from "@/components/mobile/mobile-resource-cards";
import { useResourceNavigation } from "@/components/navigation/navigation-context";

/**
 * Mobile Overview (design §01) — NOT stacked desktop cards:
 *  - 52px header (shell) + fleet health banner
 *  - horizontally scrolling metric strip (112px cards, peek at the edge)
 *  - Needs Attention directly under the metrics
 *  - compact workload cards + node cards
 *  - compact recent activity
 */

export type MobileAdminOverviewData = {
  fleetSummary: {
    nodesOnline: number;
    nodesTotal: number;
    workloadsHealthy: number;
    workloadsTotal: number;
    containersRunning: number;
    containersTotal: number;
    degradedWorkloads: number;
    unhealthyContainers: number;
    attentionIssues: number;
    activeOperations: number;
  };
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
};

export function MobileAdminOverview({ data }: { data: MobileAdminOverviewData }): React.JSX.Element {
  const router = useRouter();
  const go = useResourceNavigation();
  const { fleetSummary, nodes, attention, workloads, recentActivity, resourceThresholds } = data;
  const unexpectedAttention = attention.filter((item) => !item.maintenance);
  const attentionVisible = unexpectedAttention.length > 0;
  const fleetNominal = fleetSummary.attentionIssues === 0 && fleetSummary.nodesOnline === fleetSummary.nodesTotal;

  const metrics = [
    {
      label: "Nodes",
      value: <>{fleetSummary.nodesOnline}<span className="text-text-subtle">/{fleetSummary.nodesTotal}</span></>,
      sub: fleetSummary.nodesOnline === fleetSummary.nodesTotal ? <span className="text-success-foreground">online</span> : "need attention"
    },
    {
      label: "Workloads",
      value: <>{fleetSummary.workloadsHealthy}<span className="text-text-subtle">/{fleetSummary.workloadsTotal}</span></>,
      sub: fleetSummary.degradedWorkloads > 0 ? `${fleetSummary.degradedWorkloads} degraded` : <span className="text-success-foreground">healthy</span>
    },
    {
      label: "Containers",
      value: <>{fleetSummary.containersRunning}<span className="text-text-subtle">/{fleetSummary.containersTotal}</span></>,
      sub: fleetSummary.unhealthyContainers > 0 ? `${fleetSummary.unhealthyContainers} unhealthy` : `${fleetSummary.containersTotal - fleetSummary.containersRunning} stopped`
    },
    {
      label: "Attention",
      value: fleetSummary.attentionIssues,
      sub: fleetSummary.attentionIssues === 0 ? "no active issues" : `${fleetSummary.attentionIssues} issue${fleetSummary.attentionIssues === 1 ? "" : "s"}`
    },
    {
      label: "Operations",
      value: fleetSummary.activeOperations,
      sub: fleetSummary.activeOperations > 0 ? "active now" : "none active"
    }
  ];

  return (
    <div className="space-y-4">
      {/* Fleet health banner (design: check + one line + mono summary) */}
      <div
        className={cn(
          "mx-1 flex items-center gap-2.5 rounded-[12px] border px-3.5 py-3.5",
          fleetNominal
            ? "border-success/30 bg-success/6"
            : "border-warning/30 bg-warning/5"
        )}
      >
        <span
          className={cn(
            "grid h-[18px] w-[18px] flex-none place-items-center rounded-full",
            fleetNominal ? "bg-success" : "bg-warning"
          )}
        >
          <Check size={12} className="text-text-inverse" />
        </span>
        <div className="min-w-0">
          <p className="text-[15px] font-medium leading-5">
            {fleetNominal ? "Nothing needs you" : `${fleetSummary.attentionIssues} item${fleetSummary.attentionIssues === 1 ? "" : "s"} need attention`}
          </p>
          <p className="truncate font-mono text-[11px] text-text-muted">
            {fleetSummary.nodesOnline}/{fleetSummary.nodesTotal} nodes · {fleetSummary.workloadsTotal} workloads ·{" "}
            {fleetSummary.containersRunning}/{fleetSummary.containersTotal} running
          </p>
        </div>
      </div>

      {/* Metric strip — horizontal scroll, one card peeking */}
      <MobileMetricStrip>
        {metrics.map((metric) => (
          <MobileMetricCard key={metric.label} label={metric.label} value={metric.value} sub={metric.sub} />
        ))}
      </MobileMetricStrip>

      {/* Needs attention */}
      {attentionVisible && (
        <section aria-label="Needs attention" className="space-y-2">
          {unexpectedAttention.slice(0, 6).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => item.href && router.push(item.href)}
              className={cn(
                "flex w-full items-start justify-between gap-3 rounded-[12px] border px-3.5 py-3 text-left",
                item.severity === "critical"
                  ? "border-critical/30 bg-critical/5"
                  : item.severity === "warning"
                    ? "border-warning/30 bg-warning/5"
                    : "border-border bg-surface-raised/60"
              )}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <CardChip
                    tone={item.severity === "critical" ? "danger" : item.severity === "warning" ? "warning" : "neutral"}
                  >
                    {item.severity}
                  </CardChip>
                  <span className="truncate font-mono text-[11px] text-text-subtle">{item.conditionType}</span>
                </div>
                <p className="mt-1.5 text-sm font-medium leading-5">{item.title}</p>
                <p className="mt-0.5 line-clamp-2 text-xs leading-4 text-text-muted">{item.detail}</p>
                <p className="mt-1.5 font-mono text-[11px] text-text-subtle">
                  {timeAgo(item.firstObservedAt)}
                  {item.acknowledgement && <span className="text-info-foreground"> · acknowledged</span>}
                  {item.silence && <span> · silenced</span>}
                </p>
              </div>
            </button>
          ))}
          <a
            href="/admin/attention"
            onClick={(e) => {
              e.preventDefault();
              go({ url: "/admin/attention", label: "Attention", type: "attention" });
            }}
            className="inline-flex items-center gap-1 px-1 py-2 text-sm text-brand hover:underline"
          >
            View all attention <ArrowRight size={14} />
          </a>
        </section>
      )}

      {/* Workloads */}
      <section>
        <div className="flex items-center justify-between px-1">
          <p className="text-[15px] font-semibold">Workloads</p>
          <button
            type="button"
            onClick={() => go({ url: "/admin/workloads", label: "Workloads", type: "workloads" })}
            className="font-mono text-xs text-brand focus:outline-none focus:ring-2 focus:ring-focus"
          >
            All {workloads.length}
          </button>
        </div>
        <div className="mt-2.5 space-y-2.5">
          {workloads.slice(0, 6).map((workload) => (
            <div key={workload.id}>
              {workloadCard(workload, () =>
                go({ url: `/admin/workloads/${workload.id}`, label: workload.name, type: "workload", id: workload.id })
              )}
            </div>
          ))}
          {workloads.length === 0 && (
            <p className="rounded-[12px] border border-border bg-surface-raised/40 px-4 py-4 text-sm text-text-muted">
              No workloads yet.
            </p>
          )}
        </div>
      </section>

      {/* Nodes */}
      <section>
        <div className="flex items-center justify-between px-1">
          <p className="text-[15px] font-semibold">Nodes</p>
          <button
            type="button"
            onClick={() => go({ url: "/admin/nodes", label: "Nodes", type: "nodes" })}
            className="font-mono text-xs text-brand focus:outline-none focus:ring-2 focus:ring-focus"
          >
            Manage
          </button>
        </div>
        <div className="mt-2.5 space-y-2.5">
          {nodes.map((node) => (
            <div key={node.id}>
              {nodeCard(
                {
                  id: node.id,
                  name: node.name,
                  hostname: "",
                  lastHeartbeatAt: node.lastHeartbeatAt,
                  offline: node.offline,
                  staleHeartbeat: node.staleHeartbeat,
                  liveContainerCount: node.containerCount,
                  agentVersion: null,
                  systemInfo: node.systemInfo
                },
                resourceThresholds,
                () => go({ url: `/admin/nodes/${node.id}`, label: node.name, type: "node", id: node.id })
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Recent activity */}
      <section>
        <p className="px-1 text-[15px] font-semibold">Recent activity</p>
        <div className="mt-2.5 rounded-[12px] border border-border bg-surface-deck">
          {recentActivity.length === 0 ? (
            <p className="px-4 py-4 text-sm text-text-muted">No activity yet.</p>
          ) : (
            <ul className="divide-y divide-border/60">
              {recentActivity.slice(0, 6).map((event) => (
                <li key={event.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                  <span className="min-w-0">
                    <span className="text-[14px]">{event.humanized}</span>
                    {event.targetLabel && <span className="ml-1.5 font-mono text-[13px] text-text-muted">{event.targetLabel}</span>}
                    <span className="ml-2 text-xs text-text-muted">{event.actorEmail ?? "system"}</span>
                  </span>
                  <span className="shrink-0 font-mono text-xs text-text-subtle">{timeAgo(event.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

/* --------------------------- Client overview --------------------------- */

export type MobileClientOverviewData = {
  overview: {
    totalContainers: number;
    runningContainers: number;
    stoppedContainers: number;
    unhealthyContainers: number;
  };
  workloads: WorkloadSummary[];
  attention: AttentionItem[];
  recentActivity: Array<{ id: string; action: string; humanized: string; actorEmail: string | null; result: string; createdAt: string }>;
  recentContainers: Array<{
    assignmentId: string;
    containerId: string;
    name: string;
    image: string;
    status: string;
    expectedStopped?: boolean;
    nodeName: string;
    nodeId: string;
    nodeOnline: boolean;
    cpuPercent: number | null;
    memoryUsage: string | null;
    restartCount: number | null;
    uptime: string | null;
    createdAt: string | null;
    ports: string;
    clientName: string;
    allowedActions: string[];
    lastUpdatedAt: string;
    attention?: "critical" | "warning" | "info" | "healthy" | "unknown";
  }>;
};

export function MobileClientOverview({ data }: { data: MobileClientOverviewData }): React.JSX.Element {
  const router = useRouter();
  const go = useResourceNavigation();
  const { overview, workloads, attention, recentActivity, recentContainers } = data;
  const healthy = overview.unhealthyContainers === 0 && overview.stoppedContainers === 0;

  return (
    <div className="space-y-4">
      <div
        className={cn(
          "mx-1 flex items-center gap-2.5 rounded-[12px] border px-3.5 py-3.5",
          healthy ? "border-success/30 bg-success/6" : "border-warning/30 bg-warning/5"
        )}
      >
        <span className={cn("grid h-[18px] w-[18px] flex-none place-items-center rounded-full", healthy ? "bg-success" : "bg-warning")}>
          <Check size={12} className="text-text-inverse" />
        </span>
        <div className="min-w-0">
          <p className="text-[15px] font-medium leading-5">
            {healthy ? "Everything is running" : `${overview.unhealthyContainers + overview.stoppedContainers} container${overview.unhealthyContainers + overview.stoppedContainers === 1 ? "" : "s"} need attention`}
          </p>
          <p className="truncate font-mono text-[11px] text-text-muted">
            {overview.runningContainers}/{overview.totalContainers} running · {workloads.length} workloads
          </p>
        </div>
      </div>

      <MobileMetricStrip>
        <MobileMetricCard label="Containers" value={overview.totalContainers} sub="total" />
        <MobileMetricCard label="Running" value={overview.runningContainers} sub={<span className="text-success-foreground">running</span>} />
        <MobileMetricCard label="Stopped" value={overview.stoppedContainers} sub="stopped" />
        <MobileMetricCard label="Unhealthy" value={overview.unhealthyContainers} sub={overview.unhealthyContainers > 0 ? <span className="text-warning-foreground">needs attention</span> : "healthy"} />
      </MobileMetricStrip>

      {attention.length > 0 && (
        <section aria-label="Needs attention" className="space-y-2">
          {attention.slice(0, 5).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => item.href && router.push(item.href)}
              className={cn(
                "flex w-full items-start justify-between gap-3 rounded-[12px] border px-3.5 py-3 text-left",
                item.severity === "critical" ? "border-critical/30 bg-critical/5" : "border-warning/30 bg-warning/5"
              )}
            >
              <div className="min-w-0">
                <p className="text-sm font-medium leading-5">{item.title}</p>
                <p className="mt-0.5 line-clamp-2 text-xs leading-4 text-text-muted">{item.detail}</p>
              </div>
              <CardChip tone={item.severity === "critical" ? "danger" : "warning"}>{item.severity}</CardChip>
            </button>
          ))}
        </section>
      )}

      <section>
        <p className="px-1 text-[15px] font-semibold">Workloads</p>
        <div className="mt-2.5 space-y-2.5">
          {workloads.map((workload) => (
            <div key={workload.id}>
              {workloadCard(workload, () =>
                go({ url: `/client/workloads/${workload.id}`, label: workload.name, type: "workload", id: workload.id })
              )}
            </div>
          ))}
          {workloads.length === 0 && (
            <p className="rounded-[12px] border border-border bg-surface-raised/40 px-4 py-4 text-sm text-text-muted">
              No workloads assigned yet.
            </p>
          )}
        </div>
      </section>

      {recentContainers.length > 0 && (
        <section>
          <p className="px-1 text-[15px] font-semibold">Containers</p>
          <div className="mt-2.5 space-y-2.5">
            {recentContainers.slice(0, 5).map((container) => (
              <div key={container.assignmentId}>
                {containerCard(container as Parameters<typeof containerCard>[0], () =>
                  go({ url: `/client/containers/${container.assignmentId}`, label: container.name, type: "container", id: container.containerId })
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <p className="px-1 text-[15px] font-semibold">Recent activity</p>
        <div className="mt-2.5 rounded-[12px] border border-border bg-surface-deck">
          {recentActivity.length === 0 ? (
            <p className="px-4 py-4 text-sm text-text-muted">No activity yet.</p>
          ) : (
            <ul className="divide-y divide-border/60">
              {recentActivity.slice(0, 6).map((event) => (
                <li key={event.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                  <span className="min-w-0">
                    <span className="text-[14px]">{event.humanized}</span>
                    <span className="ml-2 text-xs text-text-muted">{event.actorEmail ?? "system"}</span>
                  </span>
                  <span className="shrink-0 font-mono text-xs text-text-subtle">{timeAgo(event.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
