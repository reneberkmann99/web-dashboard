"use client";

import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetcher";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MetricCard } from "@/components/ui/metric-card";
import { StatusBadge } from "@/components/ui/status-badge";
import { timeAgo } from "@/lib/format";
import type { ContainerView, OverviewStats, WorkloadSummary } from "@/types/domain";

type ClientOverviewResponse = {
  overview: OverviewStats;
  workloads: WorkloadSummary[];
  recentActivity: Array<{ id: string; action: string; humanized: string; actorEmail: string | null; result: string; createdAt: string }>;
  recentContainers: ContainerView[];
};

function healthVariant(health: WorkloadSummary["health"]): "success" | "warning" | "danger" | "default" {
  return health === "healthy" ? "success" : health === "degraded" ? "warning" : health === "down" ? "danger" : "default";
}

export default function ClientDashboardPage(): React.JSX.Element {
  const router = useRouter();
  const query = useQuery({
    queryKey: ["client-overview"],
    queryFn: () => apiFetch<ClientOverviewResponse>("/api/client/overview"),
    refetchInterval: 8000
  });

  const stats = query.data?.overview;
  const needsAttention = [
    ...(stats ? [{ label: "Stopped", value: stats.stoppedContainers, warn: stats.stoppedContainers > 0 }] : []),
    ...(stats ? [{ label: "Unhealthy", value: stats.unhealthyContainers, warn: stats.unhealthyContainers > 0 }] : [])
  ];

  return (
    <div className="space-y-6">
      <section>
        <h1 className="text-3xl font-semibold">Overview</h1>
        <p className="text-muted">Health of the services assigned to you.</p>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Total containers" value={stats?.totalContainers ?? "-"} />
        <MetricCard label="Running" value={stats?.runningContainers ?? "-"} />
        <MetricCard label="Stopped" value={stats?.stoppedContainers ?? "-"} />
        <MetricCard label="Unhealthy" value={stats?.unhealthyContainers ?? "-"} />
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <Card className="panel">
          <CardHeader>
            <CardTitle>Workloads</CardTitle>
            <CardDescription>Health of the services you can operate.</CardDescription>
          </CardHeader>
          <CardContent>
            {query.isLoading ? (
              <div className="space-y-3">
                <div className="h-10 animate-pulse rounded bg-panelAlt" />
                <div className="h-10 animate-pulse rounded bg-panelAlt" />
              </div>
            ) : query.data?.workloads.length ? (
              <div className="space-y-2">
                {query.data.workloads.map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    onClick={() => router.push(`/client/workloads/${w.id}`)}
                    className="flex w-full items-center justify-between rounded-lg border border-border bg-panelAlt px-4 py-3 text-left transition hover:bg-panelAlt/60"
                  >
                    <div>
                      <p className="font-medium">{w.name}</p>
                      <p className="text-xs text-muted">{w.nodeName}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted">{w.runningContainers}/{w.totalContainers} running</span>
                      <Badge variant={healthVariant(w.health)}>{w.health}</Badge>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted">No workloads assigned yet.</p>
            )}
          </CardContent>
        </Card>

        <Card className="panel">
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
            <CardDescription>What changed recently on your services.</CardDescription>
          </CardHeader>
          <CardContent>
            {query.isLoading ? (
              <div className="space-y-3">
                <div className="h-8 animate-pulse rounded bg-panelAlt" />
                <div className="h-8 animate-pulse rounded bg-panelAlt" />
              </div>
            ) : query.data?.recentActivity.length ? (
              <ul className="divide-y divide-border">
                {query.data.recentActivity.map((a) => (
                  <li key={a.id} className="flex items-center justify-between py-2 text-sm">
                    <span>
                      {a.humanized}
                      <span className="ml-2 text-xs text-muted">{a.actorEmail ?? "system"}</span>
                    </span>
                    <span className="shrink-0 text-xs text-muted">{timeAgo(a.createdAt)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">No activity yet.</p>
            )}
          </CardContent>
        </Card>
      </section>

      <Card className="panel">
        <CardHeader>
          <CardTitle>Containers</CardTitle>
          <CardDescription>Latest status from your assigned containers.</CardDescription>
        </CardHeader>
        <CardContent>
          {query.isLoading ? (
            <div className="space-y-3">
              <div className="h-10 animate-pulse rounded bg-panelAlt" />
              <div className="h-10 animate-pulse rounded bg-panelAlt" />
            </div>
          ) : query.data?.recentContainers.length ? (
            <div className="space-y-3">
              {query.data.recentContainers.map((container) => (
                <div
                  className="flex items-center justify-between rounded-lg border border-border bg-panelAlt px-4 py-3"
                  key={container.assignmentId}
                >
                  <div>
                    <p className="font-medium">{container.name}</p>
                    <p className="text-xs text-muted">{container.image}</p>
                  </div>
                  <StatusBadge status={container.status} />
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted">No assigned containers yet.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
