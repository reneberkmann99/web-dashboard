"use client";

import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetcher";
import { AttentionBadge } from "@/components/ui/attention-badge";
import { Button } from "@/components/ui/button";
import { DataTable, type Column } from "@/components/ui/data-table";
import type { WorkloadSummary } from "@/types/domain";
import { PageHeader } from "@/components/ui/page-header";

type WorkloadsPayload = { workloads: WorkloadSummary[] };

export default function ClientWorkloadsPage(): React.JSX.Element {
  const router = useRouter();
  const query = useQuery({
    queryKey: ["client-workloads"],
    queryFn: () => apiFetch<WorkloadsPayload>("/api/client/workloads"),
    refetchInterval: 10000
  });

  const columns: Column<WorkloadSummary>[] = [
    {
      key: "name",
      header: "Workload",
      sortValue: (w) => w.name,
      render: (w) => (
        <div>
          <p className="font-medium">{w.name}</p>
          <p className="text-xs text-muted">{w.nodeName}</p>
        </div>
      )
    },
    {
      key: "containers",
      header: "Containers",
      sortValue: (w) => w.runningContainers,
      render: (w) => <span className="text-sm">{w.runningContainers}/{w.totalContainers} running</span>
    },
    {
      key: "health",
      header: "Health",
      sortValue: (w) => w.health,
      render: (w) => <AttentionBadge severity={w.health === "down" ? "critical" : w.health === "degraded" ? "warning" : w.health} />
    }
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Services"
        title="Workloads"
        description="The services assigned to you."
        actions={<Button size="sm" onClick={() => router.push("/client/workloads/new")}>
          New workload
        </Button>}
      />

      <DataTable
        columns={columns}
        rows={query.data?.workloads ?? []}
        searchableText={(w) => `${w.name} ${w.nodeName}`}
        searchPlaceholder="Search workloads…"
        loading={query.isLoading}
        error={query.isError ? "Failed to load workloads" : null}
        emptyTitle="No workloads assigned"
        emptyBody="Your administrator hasn't granted you access to any workloads yet."
        onRowClick={(w) => router.push(`/client/workloads/${w.id}`)}
        rowKey={(w) => w.id}
      />
    </div>
  );
}
