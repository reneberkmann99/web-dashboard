"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetcher";
import { Badge } from "@/components/ui/badge";
import { AttentionBadge } from "@/components/ui/attention-badge";
import { ServerDataTable } from "@/components/ui/server-data-table";
import type { Column } from "@/components/ui/data-table";
import type { ContainerView } from "@/types/domain";
import { PageHeader } from "@/components/ui/page-header";
import { useResourceNavigation } from "@/components/navigation/navigation-context";

type ContainersPayload = {
  containers: ContainerView[];
  total: number;
  page: number;
  limit: number;
  pageCount: number;
};
type RefPayload = {
  nodes: Array<{ id: string; name: string }>;
  clients: Array<{ id: string; name: string }>;
  workloads: Array<{ id: string; name: string }>;
};

const PAGE_SIZE = 25;
const STATUSES = ["running", "stopped", "restarting", "unknown"] as const;

export default function SettingsContainersPage(): React.JSX.Element {
  const router = useRouter();
  const go = useResourceNavigation();
  const searchParams = useSearchParams();

  // Local filter state mirrors the URL so inputs stay responsive while the
  // URL (and therefore the query) updates on change.
  const [search, setSearch] = useState(searchParams.get("search") ?? "");
  const [status, setStatus] = useState(searchParams.get("status") ?? "");
  const [nodeId, setNodeId] = useState(searchParams.get("nodeId") ?? "");
  const [clientId, setClientId] = useState(searchParams.get("clientId") ?? "");
  const [projectId, setProjectId] = useState(searchParams.get("projectId") ?? "");
  const [health, setHealth] = useState(searchParams.get("health") ?? "");
  const [needsAttention, setNeedsAttention] = useState(searchParams.get("needsAttention") === "1");
  // Default ordering surfaces problematic containers first (§7). Explicit
  // sort column, never re-sorted purely because CPU% ticked on a poll.
  const sort = searchParams.get("sort") ?? "attention";
  const dir = searchParams.get("dir") === "desc" ? "desc" : "asc";
  const page = Math.max(Number(searchParams.get("page") ?? "1"), 1);

  const syncUrl = useCallback(
    (patch: Record<string, string>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value) params.set(key, value);
        else params.delete(key);
      }
      router.replace(`/admin/containers?${params.toString()}`, { scroll: false });
    },
    [router, searchParams]
  );

  useEffect(() => {
    syncUrl({ search, status, nodeId, clientId, projectId, health, needsAttention: needsAttention ? "1" : "" });
  }, [search, status, nodeId, clientId, projectId, health, needsAttention, syncUrl]);

  const query = useQuery({
    queryKey: ["admin-all-containers", { search, status, nodeId, clientId, projectId, health, needsAttention, sort, dir, page }],
    queryFn: () => {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (status) params.set("status", status);
      if (nodeId) params.set("nodeId", nodeId);
      if (clientId) params.set("clientId", clientId);
      if (projectId) params.set("projectId", projectId);
      if (health) params.set("health", health);
      if (needsAttention) params.set("needsAttention", "1");
      params.set("sort", sort);
      params.set("dir", dir);
      params.set("page", String(page));
      params.set("limit", String(PAGE_SIZE));
      return apiFetch<ContainersPayload>(`/api/admin/containers?${params.toString()}`);
    },
    refetchInterval: 10000
  });

  const refsQuery = useQuery({
    queryKey: ["admin-containers-refs"],
    queryFn: () => apiFetch<RefPayload>("/api/admin/clients-refs")
  });

  const columns: Column<ContainerView>[] = [
    {
      key: "name",
      header: "Container",
      sortValue: (c) => c.name,
      render: (c) => (
        <div>
          <p className="font-medium">{c.name}</p>
          <p className="text-xs text-muted">{c.projectName ?? "—"}</p>
        </div>
      )
    },
    { key: "node", header: "Node", sortValue: (c) => c.nodeName, render: (c) => <span className="text-sm">{c.nodeName}</span>, hideBelow: "sm" },
    { key: "client", header: "Client", sortValue: (c) => c.clientName, render: (c) => <span className="text-sm">{c.clientName}</span>, hideBelow: "sm" },
    { key: "status", header: "State", sortValue: (c) => c.status, render: (c) => <Badge variant={c.status === "running" ? "success" : c.status === "stopped" ? "danger" : "warning"}>{c.status}</Badge> },
    { key: "health", header: "Health", sortValue: (c) => c.health ?? "none", render: (c) => c.health ? <Badge variant={c.health === "healthy" ? "success" : c.health === "unhealthy" ? "danger" : "warning"}>{c.health}</Badge> : <span className="text-xs text-muted">—</span> },
    { key: "cpu", header: "CPU", sortValue: (c) => c.cpuPercent ?? -1, render: (c) => <span className="text-sm">{c.cpuPercent !== null ? `${c.cpuPercent.toFixed(1)}%` : "—"}</span>, hideBelow: "md" },
    { key: "mem", header: "Memory", render: (c) => <span className="text-sm">{c.memoryUsage ?? "—"}</span>, hideBelow: "md" },
    { key: "restartCount", header: "Restarts", sortValue: (c) => c.restartCount ?? 0, render: (c) => <span className="text-sm">{c.restartCount ?? 0}</span>, hideBelow: "lg" },
    { key: "uptime", header: "Uptime", render: (c) => <span className="text-xs text-muted">{c.uptime ?? "—"}</span>, hideBelow: "lg" },
    {
      key: "attention",
      header: "Attention",
      sortValue: (c) => c.attention ?? "healthy",
      render: (c) => (c.attention && c.attention !== "healthy" ? <AttentionBadge severity={c.attention} /> : <span className="text-xs text-muted">—</span>)
    }
  ];

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Runtime inventory" title="Containers" description="Every container across all nodes, including unassigned ones." />

      <div className="flex flex-wrap gap-2">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search containers…"
          aria-label="Search containers"
          className="w-64 rounded-md border border-border bg-panelAlt px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-accent"
        />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          aria-label="Filter by status"
          className="rounded-md border border-border bg-panelAlt px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-accent"
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <select
          value={nodeId}
          onChange={(e) => setNodeId(e.target.value)}
          aria-label="Filter by node"
          className="rounded-md border border-border bg-panelAlt px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-accent"
        >
          <option value="">All nodes</option>
          {(refsQuery.data?.nodes ?? []).map((n) => (
            <option key={n.id} value={n.id}>{n.name}</option>
          ))}
        </select>
        <select
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          aria-label="Filter by client"
          className="rounded-md border border-border bg-panelAlt px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-accent"
        >
          <option value="">All clients</option>
          {(refsQuery.data?.clients ?? []).map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <select
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          aria-label="Filter by workload"
          className="rounded-md border border-border bg-panelAlt px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-accent"
        >
          <option value="">All workloads</option>
          {(refsQuery.data?.workloads ?? []).map((w) => (
            <option key={w.id} value={w.id}>{w.name}</option>
          ))}
        </select>
        <select
          value={health}
          onChange={(e) => setHealth(e.target.value)}
          aria-label="Filter by health"
          className="rounded-md border border-border bg-panelAlt px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-accent"
        >
          <option value="">All health states</option>
          <option value="healthy">Healthy</option>
          <option value="unhealthy">Unhealthy</option>
          <option value="starting">Starting</option>
          <option value="none">No healthcheck</option>
        </select>
        <label className="flex items-center gap-2 rounded-md border border-border bg-panelAlt px-3 py-1.5 text-sm">
          <input
            type="checkbox"
            checked={needsAttention}
            onChange={(e) => setNeedsAttention(e.target.checked)}
            className="accent-accent"
          />
          Needs attention only
        </label>
      </div>

      <ServerDataTable
        columns={columns}
        rows={query.data?.containers ?? []}
        total={query.data?.total ?? 0}
        page={query.data?.page ?? page}
        pageSize={PAGE_SIZE}
        onPageChange={(p) => syncUrl({ page: String(p) })}
        sortKey={sort}
        sortDir={dir}
        onSortChange={(key) => {
          const nextDir = key === sort && dir === "asc" ? "desc" : "asc";
          syncUrl({ sort: key, dir: nextDir, page: "1" });
        }}
        loading={query.isLoading}
        error={query.isError ? "Failed to load containers" : null}
        emptyTitle="No containers"
        emptyBody="Containers appear here once an agent reports them."
        onRowClick={(c) => {
          go({ url: `/admin/containers/${c.nodeId}/${c.containerId}`, label: c.name, type: "container", id: c.containerId });
        }}
        rowKey={(c) => `${c.nodeId}:${c.containerId}`}
      />
    </div>
  );
}
