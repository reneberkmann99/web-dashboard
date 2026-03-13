"use client";

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetcher";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MetricCard } from "@/components/ui/metric-card";
import type { AdminOverview } from "@/types/domain";

export default function AdminDashboardPage(): React.JSX.Element {
  const query = useQuery({
    queryKey: ["admin-overview"],
    queryFn: () => apiFetch<AdminOverview>("/api/admin/overview"),
    refetchInterval: 10000
  });

  return (
    <div className="space-y-6">
      <section>
        <h1 className="text-3xl font-semibold">Administrator dashboard</h1>
        <p className="text-muted">Cross-client visibility, health summary, and recent control actions.</p>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <MetricCard label="Clients" value={query.data?.totalClients ?? "-"} />
        <MetricCard label="Nodes" value={query.data?.totalNodes ?? "-"} />
        <MetricCard label="Containers" value={query.data?.totalContainers ?? "-"} />
        <MetricCard label="Running" value={query.data?.runningContainers ?? "-"} />
        <MetricCard label="Stopped" value={query.data?.stoppedContainers ?? "-"} />
        <MetricCard label="Offline nodes" value={query.data?.offlineNodes ?? "-"} />
      </section>

      <Card className="panel">
        <CardHeader>
          <CardTitle>Recent actions</CardTitle>
          <CardDescription>Latest audit log entries.</CardDescription>
        </CardHeader>
        <CardContent>
          {query.isLoading ? (
            <div className="space-y-3">
              <div className="h-10 animate-pulse rounded bg-panelAlt" />
              <div className="h-10 animate-pulse rounded bg-panelAlt" />
            </div>
          ) : query.isError ? (
            <p className="text-sm text-red-400">Failed to load recent actions.</p>
          ) : query.data?.recentActions.length ? (
            <div className="space-y-3 text-sm">
              {query.data.recentActions.map((entry) => (
                <div className="rounded-lg border border-border bg-panelAlt px-4 py-3" key={entry.id}>
                  <p className="font-medium">{entry.action}</p>
                  <p className="text-xs text-muted">
                    {entry.actorEmail ?? "system"} · {entry.result} · {new Date(entry.createdAt).toLocaleString()}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted">No actions recorded yet.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}


