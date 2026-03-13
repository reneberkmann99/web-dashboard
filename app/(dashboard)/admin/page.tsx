"use client";

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetcher";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type AdminOverview = {
  totalClients: number;
  totalNodes: number;
  totalContainers: number;
  runningContainers: number;
  stoppedContainers: number;
  offlineNodes: number;
  recentActions: Array<{
    id: string;
    action: string;
    actorEmail: string | null;
    result: "SUCCESS" | "FAILURE";
    createdAt: string;
  }>;
};

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
        <SummaryCard label="Clients" value={query.data?.totalClients ?? "-"} />
        <SummaryCard label="Nodes" value={query.data?.totalNodes ?? "-"} />
        <SummaryCard label="Containers" value={query.data?.totalContainers ?? "-"} />
        <SummaryCard label="Running" value={query.data?.runningContainers ?? "-"} />
        <SummaryCard label="Stopped" value={query.data?.stoppedContainers ?? "-"} />
        <SummaryCard label="Offline nodes" value={query.data?.offlineNodes ?? "-"} />
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

function SummaryCard({ label, value }: { label: string; value: string | number }): React.JSX.Element {
  return (
    <Card className="panel">
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="metric-value">{value}</p>
      </CardContent>
    </Card>
  );
}
