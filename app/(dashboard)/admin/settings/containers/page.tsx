"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetcher";
import { Badge } from "@/components/ui/badge";
import { ServerDataTable } from "@/components/ui/server-data-table";
import type { Column } from "@/components/ui/data-table";
import type { ContainerView } from "@/types/domain";

type ContainersPayload = {
  containers: ContainerView[];
  total: number;
  page: number;
  limit: number;
  pageCount: number;
};
type RefPayload = { nodes: Array<{ id: string; name: string }>; clients: Array<{ id: string; name: string }> };

const PAGE_SIZE = 25;
const STATUSES = ["running", "stopped", "restarting", "unhealthy"] as const;

export default function SettingsContainersPage(): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Local filter state mirrors the URL so inputs stay responsive while the
  // URL (and therefore the query) updates on change.
  const [search, setSearch] = useState(searchParams.get("search") ?? "");
  const [status, setStatus] = useState(searchParams.get("status") ?? "");
  const [nodeId, setNodeId] = useState(searchParams.get("nodeId") ?? "");
  const [clientId, setClientId] = useState(searchParams.get("clientId") ?? "");
  const sort = searchParams.get("sort") ?? "name";
  const dir = searchParams.get("dir") === "desc" ? "desc" : "asc";
  const page = Math.max(Number(searchParams.get("page") ?? "1"), 1);

  const syncUrl = useCallback(
    (patch: Record<string, string>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value) params.set(key, value);
        else params.delete(key);
      }
      router.replace(`/admin/settings/containers?${params.toString()}`, { scroll: false });
    },
    [router, searchParams]
  );

  useEffect(() => {
    syncUrl({ search, status, nodeId, clientId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, status, nodeId, clientId]);

  const query = useQuery({
    queryKey: ["admin-all-containers", { search, status, nodeId, clientId, sort, dir, page }],
    queryFn: () => {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (status) params.set("status", status);
      if (nodeId) params.set("nodeId", nodeId);
      if (clientId) params.set("clientId", clientId);
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
          <p className="text-xs text-muted">{c.containerId.slice(0, 12)}</p>
        </div>
      )
    },
    { key: "node", header: "Node", sortValue: (c) => c.nodeName, render: (c) => <span className="text-sm">{c.nodeName}</span>, hideBelow: "sm" },
    { key: "client", header: "Client", sortValue: (c) => c.clientName, render: (c) => <span className="text-sm">{c.clientName}</span>, hideBelow: "sm" },
    { key: "status", header: "Status", sortValue: (c) => c.status, render: (c) => <Badge variant={c.status === "running" ? "success" : c.status === "stopped" ? "danger" : "warning"}>{c.status}</Badge> },
    { key: "cpu", header: "CPU", sortValue: (c) => c.cpuPercent ?? -1, render: (c) => <span className="text-sm">{c.cpuPercent !== null ? `${c.cpuPercent.toFixed(1)}%` : "—"}</span>, hideBelow: "md" },
    { key: "mem", header: "Memory", render: (c) => <span className="text-sm">{c.memoryUsage ?? "—"}</span>, hideBelow: "md" }
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">All containers</h1>
        <p className="text-muted">Every container across all nodes, including unassigned ones.</p>
      </div>

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
        onRowClick={(c) => router.push(`/admin/containers/${c.nodeId}/${c.containerId}`)}
        rowKey={(c) => `${c.nodeId}:${c.containerId}`}
      />
    </div>
  );
}
