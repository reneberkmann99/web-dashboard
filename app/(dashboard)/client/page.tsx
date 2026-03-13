"use client";

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetcher";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MetricCard } from "@/components/ui/metric-card";
import { StatusBadge } from "@/components/ui/status-badge";
import type { ContainerView, OverviewStats } from "@/types/domain";

type ClientOverviewResponse = {
  overview: OverviewStats;
  recentContainers: ContainerView[];
};

export default function ClientDashboardPage(): React.JSX.Element {
  const query = useQuery({
    queryKey: ["client-overview"],
    queryFn: () => apiFetch<ClientOverviewResponse>("/api/client/overview"),
    refetchInterval: 8000
  });

  const stats = query.data?.overview;

  return (
    <div className="space-y-6">
      <section>
        <h1 className="text-3xl font-semibold">Client dashboard</h1>
        <p className="text-muted">Monitor your assigned services and control allowed containers.</p>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Total containers" value={stats?.totalContainers ?? "-"} />
        <MetricCard label="Running" value={stats?.runningContainers ?? "-"} />
        <MetricCard label="Stopped" value={stats?.stoppedContainers ?? "-"} />
        <MetricCard label="Offline nodes" value={stats?.offlineNodes ?? "-"} />
      </section>

      <Card className="panel">
        <CardHeader>
          <CardTitle>Recent containers</CardTitle>
          <CardDescription>Latest status from your assigned containers.</CardDescription>
        </CardHeader>
        <CardContent>
          {query.isLoading ? (
            <div className="space-y-3">
              <div className="h-10 animate-pulse rounded bg-panelAlt" />
              <div className="h-10 animate-pulse rounded bg-panelAlt" />
              <div className="h-10 animate-pulse rounded bg-panelAlt" />
            </div>
          ) : query.isError ? (
            <p className="text-sm text-red-400">Failed to load containers.</p>
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


