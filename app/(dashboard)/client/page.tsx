"use client";

import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetcher";
import { Badge } from "@/components/ui/badge";
import { AttentionBadge } from "@/components/ui/attention-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MetricCard } from "@/components/ui/metric-card";
import { StatusBadge } from "@/components/ui/status-badge";
import { timeAgo } from "@/lib/format";
import type { AttentionItem, ContainerView, OverviewStats, WorkloadSummary } from "@/types/domain";

type ClientOverviewResponse = {
  overview: OverviewStats;
  workloads: WorkloadSummary[];
  attention: AttentionItem[];
  activeOperations: Array<{ id: string; type: string; state: string; targetName: string; href: string | null }>;
  recentActivity: Array<{ id: string; action: string; humanized: string; actorEmail: string | null; result: string; createdAt: string }>;
  recentContainers: ContainerView[];
};

function healthVariant(health: WorkloadSummary["health"]): "success" | "warning" | "danger" | "default" {
  return health === "healthy" ? "success" : health === "degraded" ? "warning" : health === "down" ? "danger" : "default";
}

function humanizeOperation(type: string): string {
  return type.toLowerCase().replaceAll("_", " ").replace(/^./, (value) => value.toUpperCase());
}

export default function ClientDashboardPage(): React.JSX.Element {
  const router = useRouter();
  const query = useQuery({
    queryKey: ["client-overview"],
    queryFn: () => apiFetch<ClientOverviewResponse>("/api/client/overview"),
    refetchInterval: 8000
  });

  const stats = query.data?.overview;
  const attention = query.data?.attention ?? [];

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

      {/* Needs attention — workload-scoped only (§18); no node/infra detail is ever exposed to clients */}
      {attention.length > 0 && (
        <section aria-label="Needs attention">
          <h2 className="mb-2 text-lg font-semibold text-amber-300">Needs attention</h2>
          <div className="space-y-2">
            {attention.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => item.href && router.push(item.href)}
                className={`flex w-full items-start justify-between gap-3 rounded-lg border p-3 text-left ${
                  item.severity === "critical" ? "border-danger/30 bg-danger/5" : "border-warning/30 bg-warning/5"
                }`}
              >
                <div>
                  <p className="text-sm font-medium">{item.title}</p>
                  <p className="text-xs text-muted">{item.detail}</p>
                </div>
                <AttentionBadge severity={item.severity} />
              </button>
            ))}
          </div>
        </section>
      )}

      {(query.data?.activeOperations.length ?? 0) > 0 && (
        <section aria-label="Active operations">
          <h2 className="mb-2 text-lg font-semibold">Active operations</h2>
          <div className="space-y-2">
            {query.data!.activeOperations.map((operation) => (
              <button
                key={operation.id}
                type="button"
                onClick={() => operation.href && router.push(operation.href)}
                className="flex w-full items-center justify-between rounded-lg border border-accent/30 bg-accent/5 px-4 py-3 text-left text-sm"
              >
                <span>{humanizeOperation(operation.type)} — {operation.targetName}</span>
                <Badge variant="warning">{operation.state.toLowerCase()}</Badge>
              </button>
            ))}
          </div>
        </section>
      )}

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
