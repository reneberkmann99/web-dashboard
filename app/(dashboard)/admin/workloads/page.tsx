"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Compass } from "lucide-react";
import { apiFetch } from "@/lib/fetcher";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { timeAgo } from "@/lib/format";
import type { WorkloadSummary } from "@/types/domain";

type WorkloadsPayload = { workloads: WorkloadSummary[] };
type RefPayload = { nodes: Array<{ id: string; name: string }>; clients: Array<{ id: string; name: string }> };

function healthVariant(health: WorkloadSummary["health"]): "success" | "warning" | "danger" | "default" {
  return health === "healthy" ? "success" : health === "degraded" ? "warning" : health === "down" ? "danger" : "default";
}

export default function AdminWorkloadsPage(): React.JSX.Element {
  const router = useRouter();
  const [nodeFilter, setNodeFilter] = useState("");
  const [clientFilter, setClientFilter] = useState("");
  const [stateFilter, setStateFilter] = useState("");

  const workloadsQuery = useQuery({
    queryKey: ["admin-workloads"],
    queryFn: () => apiFetch<WorkloadsPayload>("/api/admin/workloads")
  });
  const refsQuery = useQuery({
    queryKey: ["admin-workloads-refs"],
    queryFn: () => apiFetch<RefPayload>("/api/admin/clients-refs")
  });

  const rows = useMemo(() => {
    let out = workloadsQuery.data?.workloads ?? [];
    if (nodeFilter) out = out.filter((w) => w.nodeId === nodeFilter);
    if (clientFilter) out = out.filter((w) => w.clientId === clientFilter);
    if (stateFilter) out = out.filter((w) => w.health === stateFilter);
    return out;
  }, [workloadsQuery.data, nodeFilter, clientFilter, stateFilter]);

  const columns: Column<WorkloadSummary>[] = [
    {
      key: "name",
      header: "Workload",
      sortValue: (w) => w.name,
      render: (w) => (
        <div>
          <p className="font-medium">{w.name}</p>
          <p className="text-xs text-muted">{w.description ?? w.slug}</p>
        </div>
      )
    },
    {
      key: "node",
      header: "Node",
      sortValue: (w) => w.nodeName,
      render: (w) => <span className="text-sm">{w.nodeName}</span>,
      hideBelow: "sm"
    },
    {
      key: "client",
      header: "Client",
      sortValue: (w) => w.clientName ?? "",
      render: (w) => <span className="text-sm">{w.clientName ?? "—"}</span>,
      hideBelow: "sm"
    },
    {
      key: "status",
      header: "Containers",
      sortValue: (w) => w.runningContainers,
      render: (w) => (
        <span className="text-sm">
          {w.runningContainers}/{w.totalContainers} running
        </span>
      )
    },
    {
      key: "health",
      header: "Health",
      sortValue: (w) => w.health,
      render: (w) => <Badge variant={healthVariant(w.health)}>{w.health}</Badge>
    },
    {
      key: "resources",
      header: "Resources",
      hideBelow: "md",
      render: (w) => (
        <span className="text-xs text-muted">
          {w.cpuPercent !== null ? `${w.cpuPercent}% CPU` : "— CPU"}
          {w.memoryUsage ? ` · ${w.memoryUsage}` : ""}
        </span>
      )
    },
    {
      key: "lastEvent",
      header: "Last event",
      sortValue: (w) => w.lastEvent?.createdAt ?? "",
      hideBelow: "lg",
      render: (w) =>
        w.lastEvent ? (
          <span className="text-xs text-muted">
            {timeAgo(w.lastEvent.createdAt)}
            <span className="block">{w.lastEvent.action.toLowerCase()}</span>
          </span>
        ) : (
          <span className="text-xs text-muted">—</span>
        )
    }
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold">Workloads</h1>
          <p className="text-muted">Logical services running across your infrastructure.</p>
        </div>
        <Button variant="secondary" onClick={() => router.push("/admin/compose")}>
          <Compass size={14} className="mr-2" />
          Discover Compose projects
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        <select
          value={nodeFilter}
          onChange={(e) => setNodeFilter(e.target.value)}
          aria-label="Filter by node"
          className="rounded-md border border-border bg-panelAlt px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-accent"
        >
          <option value="">All nodes</option>
          {(refsQuery.data?.nodes ?? []).map((n) => (
            <option key={n.id} value={n.id}>
              {n.name}
            </option>
          ))}
        </select>
        <select
          value={clientFilter}
          onChange={(e) => setClientFilter(e.target.value)}
          aria-label="Filter by client"
          className="rounded-md border border-border bg-panelAlt px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-accent"
        >
          <option value="">All clients</option>
          {(refsQuery.data?.clients ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          value={stateFilter}
          onChange={(e) => setStateFilter(e.target.value)}
          aria-label="Filter by state"
          className="rounded-md border border-border bg-panelAlt px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-accent"
        >
          <option value="">All states</option>
          <option value="healthy">Healthy</option>
          <option value="degraded">Degraded</option>
          <option value="down">Down</option>
          <option value="unknown">Unknown</option>
        </select>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        searchableText={(w) => `${w.name} ${w.nodeName} ${w.clientName ?? ""} ${w.description ?? ""}`}
        searchPlaceholder="Search workloads…"
        loading={workloadsQuery.isLoading}
        error={workloadsQuery.isError ? "Failed to load workloads" : null}
        emptyTitle="No workloads yet"
        emptyBody="Create a stack and attach containers to group them into a logical workload."
        onRowClick={(w) => router.push(`/admin/workloads/${w.id}`)}
      />
    </div>
  );
}
