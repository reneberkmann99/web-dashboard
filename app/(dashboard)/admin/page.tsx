"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Cpu, HardDrive, MemoryStick } from "lucide-react";
import { apiFetch } from "@/lib/fetcher";
import { Badge } from "@/components/ui/badge";
import { MetricCard } from "@/components/ui/metric-card";
import { timeAgo } from "@/lib/format";
import type { AttentionItem, WorkloadSummary } from "@/types/domain";

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
};

export default function AdminOverviewPage(): React.JSX.Element {
  const query = useQuery({
    queryKey: ["admin-overview"],
    queryFn: () => apiFetch<OverviewPayload>("/api/admin/overview"),
    refetchInterval: 20000
  });

  if (query.isLoading) {
    return (
      <div className="space-y-6">
        <div className="h-10 w-64 animate-pulse rounded bg-panelAlt" />
        <div className="grid gap-4 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
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

  const { utilization, nodes, attention, workloads, recentActivity } = query.data;
  const offlineNodes = nodes.filter((n) => n.offline || n.staleHeartbeat);
  const attentionVisible = attention.length > 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Overview</h1>
        <p className="text-muted">What requires your attention right now.</p>
      </div>

      {/* Summary */}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          icon={HardDrive}
          label="Containers"
          value={`${utilization.runningContainers}/${utilization.totalContainers}`}
          sub={`${utilization.stoppedContainers} stopped · ${utilization.unhealthyContainers} unhealthy`}
        />
        <MetricCard
          icon={Cpu}
          label="CPU (avg)"
          value={utilization.cpuPercent !== null ? `${utilization.cpuPercent}%` : "—"}
          sub="across running containers"
        />
        <MetricCard
          icon={MemoryStick}
          label="Memory"
          value={utilization.memoryUsage ?? "—"}
          sub="used by containers"
        />
        <MetricCard
          icon={AlertTriangle}
          label="Nodes"
          value={`${nodes.filter((n) => n.status === "ONLINE").length}/${nodes.length}`}
          sub={
            offlineNodes.length > 0
              ? `${offlineNodes.length} need attention`
              : "all healthy"
          }
        />
      </div>

      {/* Needs attention — only when something is wrong */}
      {attentionVisible && (
        <section aria-label="Needs attention">
          <h2 className="mb-2 text-lg font-semibold text-amber-300">Needs attention</h2>
          <div className="space-y-2">
            {attention.map((item, index) => (
              <div
                key={`${item.category}-${item.title}-${index}`}
                className="flex items-start justify-between gap-3 rounded-lg border border-border bg-panelAlt/60 p-3"
              >
                <div>
                  <p className="text-sm font-medium">{item.title}</p>
                  <p className="text-xs text-muted">{item.detail}</p>
                </div>
                <Badge
                  variant={
                    item.severity === "critical"
                      ? "danger"
                      : item.severity === "warning"
                        ? "warning"
                        : "default"
                  }
                >
                  {item.category}
                </Badge>
              </div>
            ))}
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
                  <Badge
                    variant={
                      w.health === "healthy"
                        ? "success"
                        : w.health === "degraded"
                          ? "warning"
                          : w.health === "down"
                            ? "danger"
                            : "default"
                    }
                  >
                    {w.health}
                  </Badge>
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
