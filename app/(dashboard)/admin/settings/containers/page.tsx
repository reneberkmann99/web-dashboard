"use client";

import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetcher";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import type { ContainerView } from "@/types/domain";

type ContainersPayload = { containers: ContainerView[] };

export default function SettingsContainersPage(): React.JSX.Element {
  const router = useRouter();
  const query = useQuery({
    queryKey: ["admin-all-containers"],
    queryFn: () => apiFetch<ContainersPayload>("/api/admin/containers"),
    refetchInterval: 10000
  });

  const columns: Column<ContainerView>[] = [
    {
      key: "name",
      header: "Container",
      sortValue: (c) => c.name,
      render: (c) => (
        <div>
          <p className="font-medium">{c.name}</p>
          <p className="text-xs text-muted">{c.containerId.slice(0, 12)}</p>
        </div>
      )
    },
    { key: "node", header: "Node", sortValue: (c) => c.nodeName, render: (c) => <span className="text-sm">{c.nodeName}</span>, hideBelow: "sm" },
    { key: "client", header: "Client", sortValue: (c) => c.clientName, render: (c) => <span className="text-sm">{c.clientName}</span>, hideBelow: "sm" },
    { key: "status", header: "Status", sortValue: (c) => c.status, render: (c) => <Badge variant={c.status === "running" ? "success" : c.status === "stopped" ? "danger" : "warning"}>{c.status}</Badge> },
    { key: "cpu", header: "CPU", render: (c) => <span className="text-sm">{c.cpuPercent !== null ? `${c.cpuPercent.toFixed(1)}%` : "—"}</span>, hideBelow: "md" },
    { key: "mem", header: "Memory", render: (c) => <span className="text-sm">{c.memoryUsage ?? "—"}</span>, hideBelow: "md" }
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">All containers</h1>
        <p className="text-muted">Every container across all nodes, including unassigned ones.</p>
      </div>

      <DataTable
        columns={columns}
        rows={query.data?.containers ?? []}
        searchableText={(c) => `${c.name} ${c.image} ${c.nodeName} ${c.clientName}`}
        searchPlaceholder="Search containers…"
        loading={query.isLoading}
        error={query.isError ? "Failed to load containers" : null}
        emptyTitle="No containers"
        emptyBody="Containers appear here once an agent reports them."
        onRowClick={(c) => {
          // find the node id from the row — ContainerView has nodeId
          router.push(`/admin/containers/${c.nodeId}/${c.containerId}`);
        }}
        rowKey={(c) => `${c.nodeId}:${c.containerId}`}
      />
    </div>
  );
}
