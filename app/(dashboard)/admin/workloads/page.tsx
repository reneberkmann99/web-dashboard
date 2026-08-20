"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Compass } from "lucide-react";
import { apiFetch } from "@/lib/fetcher";
import { Button } from "@/components/ui/button";
import { AttentionBadge } from "@/components/ui/attention-badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { PageHeader } from "@/components/ui/page-header";
import { Select } from "@/components/ui/select";
import { timeAgo } from "@/lib/format";
import type { WorkloadSummary } from "@/types/domain";

type WorkloadsPayload = { workloads: WorkloadSummary[] };
type RefPayload = { nodes: Array<{ id: string; name: string }>; clients: Array<{ id: string; name: string }> };

const ATTENTION_RANK: Record<string, number> = { critical: 0, warning: 1, info: 2, unknown: 3, healthy: 4 };

function healthAttention(w: WorkloadSummary): "critical" | "warning" | "info" | "healthy" | "unknown" {
  if (w.attention === "critical" || w.attention === "warning") return w.attention;
  if (w.health === "down") return "critical";
  if (w.health === "degraded") return "warning";
  if (w.health === "unknown") return "unknown";
  return "healthy";
}

export default function AdminWorkloadsPage(): React.JSX.Element {
  const router = useRouter();
  const [nodeFilter, setNodeFilter] = useState("");
  const [clientFilter, setClientFilter] = useState("");
  const [stateFilter, setStateFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [needsAttentionOnly, setNeedsAttentionOnly] = useState(false);

  const workloadsQuery = useQuery({
    queryKey: ["admin-workloads"],
    queryFn: () => apiFetch<WorkloadsPayload>("/api/admin/workloads"),
    refetchInterval: 20000
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
    if (sourceFilter) out = out.filter((w) => w.source === sourceFilter);
    if (needsAttentionOnly) out = out.filter((w) => healthAttention(w) === "critical" || healthAttention(w) === "warning");
    // Default view surfaces problems first (§5): explicit severity rank, then
    // alphabetical — never resorts purely on a fluctuating metric like CPU%.
    return [...out].sort((a, b) => {
      const diff = ATTENTION_RANK[healthAttention(a)] - ATTENTION_RANK[healthAttention(b)];
      if (diff !== 0) return diff;
      return a.name.localeCompare(b.name);
    });
  }, [workloadsQuery.data, nodeFilter, clientFilter, stateFilter, sourceFilter, needsAttentionOnly]);

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
      render: (w) => <span className="font-mono text-sm">{w.nodeName}</span>,
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
      key: "source",
      header: "Type",
      sortValue: (w) => w.source,
      render: (w) => <span className="text-xs text-muted">{w.source}</span>,
      hideBelow: "md"
    },
    {
      key: "status",
      header: "Containers",
      sortValue: (w) => w.runningContainers,
      render: (w) => (
        <span className="font-mono text-sm">
          {w.runningContainers}/{w.totalContainers} running
        </span>
      )
    },
    {
      key: "health",
      header: "Health",
      sortValue: (w) => w.health,
      render: (w) => <AttentionBadge severity={healthAttention(w)} label={w.health} />
    },
    {
      key: "attention",
      header: "Attention",
      sortValue: (w) => ATTENTION_RANK[healthAttention(w)],
      render: (w) => {
        const a = healthAttention(w);
        return a === "healthy" ? <span className="text-xs text-muted">—</span> : <AttentionBadge severity={a} />;
      },
      hideBelow: "md"
    },
    {
      key: "resources",
      header: "Resources",
      hideBelow: "md",
      render: (w) => (
        <span className="font-mono text-xs text-muted">
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
      <PageHeader
        eyebrow="Fleet"
        title="Workloads"
        description="Logical services running across your infrastructure."
        actions={<Button variant="secondary" onClick={() => router.push("/admin/compose")}>
          <Compass size={14} className="mr-2" />
          Discover Compose projects
        </Button>}
      />

      <div className="flex flex-wrap gap-2">
        <Select
          value={nodeFilter}
          onChange={(e) => setNodeFilter(e.target.value)}
          aria-label="Filter by node"
          className="w-auto min-w-40"
        >
          <option value="">All nodes</option>
          {(refsQuery.data?.nodes ?? []).map((n) => (
            <option key={n.id} value={n.id}>
              {n.name}
            </option>
          ))}
        </Select>
        <Select
          value={clientFilter}
          onChange={(e) => setClientFilter(e.target.value)}
          aria-label="Filter by client"
          className="w-auto min-w-40"
        >
          <option value="">All clients</option>
          {(refsQuery.data?.clients ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Select
          value={stateFilter}
          onChange={(e) => setStateFilter(e.target.value)}
          aria-label="Filter by state"
          className="w-auto min-w-36"
        >
          <option value="">All states</option>
          <option value="healthy">Healthy</option>
          <option value="degraded">Degraded</option>
          <option value="down">Down</option>
          <option value="unknown">Unknown</option>
        </Select>
        <Select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
          aria-label="Filter by source type"
          className="w-auto min-w-40"
        >
          <option value="">All types</option>
          <option value="MANUAL">Manual</option>
          <option value="COMPOSE">External Compose</option>
          <option value="MANAGED">Managed</option>
        </Select>
        <label className="flex h-control items-center gap-2 rounded-control border border-border bg-surface-raised px-3 text-sm text-text-muted">
          <input
            type="checkbox"
            checked={needsAttentionOnly}
            onChange={(e) => setNeedsAttentionOnly(e.target.checked)}
            className="accent-accent"
          />
          Needs attention only
        </label>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        searchableText={(w) => `${w.name} ${w.nodeName} ${w.clientName ?? ""} ${w.description ?? ""} ${w.source}`}
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
