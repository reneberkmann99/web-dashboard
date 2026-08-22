"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/lib/fetcher";
import { Badge } from "@/components/ui/badge";
import { AttentionBadge } from "@/components/ui/attention-badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { ServerDataTable } from "@/components/ui/server-data-table";
import type { Column } from "@/components/ui/data-table";
import type { ContainerView } from "@/types/domain";
import { PageHeader } from "@/components/ui/page-header";
import { useResourceNavigation } from "@/components/navigation/navigation-context";
import { FilterSheet, type FilterDraft } from "@/components/mobile/filter-sheet";
import { MobileFiltersRow, containerCard } from "@/components/mobile/mobile-resource-cards";
import { DesktopFilterBar } from "@/components/ui/desktop-filter-bar";
import { Menu } from "@/components/ui/menu";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { compactMemory, compactUptime } from "@/lib/format";

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
  const queryClient = useQueryClient();

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

  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetCount, setSheetCount] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmBulk, setConfirmBulk] = useState<"start" | "stop" | "restart" | null>(null);

  const syncUrl = useCallback(
    (patch: Record<string, string>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value) params.set(key, value);
        else params.delete(key);
      }
      const query = params.toString();
      router.push(query ? `/admin/containers?${query}` : "/admin/containers", { scroll: false });
    },
    [router, searchParams]
  );

  useEffect(() => {
    setSearch(searchParams.get("search") ?? "");
    setStatus(searchParams.get("status") ?? "");
    setNodeId(searchParams.get("nodeId") ?? "");
    setClientId(searchParams.get("clientId") ?? "");
    setProjectId(searchParams.get("projectId") ?? "");
    setHealth(searchParams.get("health") ?? "");
    setNeedsAttention(searchParams.get("needsAttention") === "1");
  }, [searchParams]);

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
  const totalQuery = useQuery({
    queryKey: ["admin-all-containers-total"],
    queryFn: () => apiFetch<ContainersPayload>("/api/admin/containers?page=1&limit=1&sort=attention&dir=asc"),
    refetchInterval: 30_000
  });

  const bulkMutation = useMutation({
    mutationFn: (input: { action: "start" | "stop" | "restart"; targets: Array<{ nodeId: string; containerId: string }> }) =>
      apiFetch<{ queued: number; failures: Array<{ containerId: string; reason: string }> }>("/api/admin/containers/bulk", {
        method: "POST",
        body: JSON.stringify(input)
      }),
    onSuccess: async (data) => {
      if (data.failures.length > 0) toast.warning(`${data.queued} queued · ${data.failures.length} skipped`);
      else toast.success(`${data.queued} container action${data.queued === 1 ? "" : "s"} queued`);
      setSelected(new Set());
      await queryClient.invalidateQueries({ queryKey: ["admin-all-containers"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Bulk action failed")
  });

  useEffect(() => {
    setSelected(new Set());
  }, [page]);

  const currentRows = query.data?.containers ?? [];
  const selectedRows = useMemo(
    () => currentRows.filter((container) => selected.has(`${container.nodeId}:${container.containerId}`)),
    [currentRows, selected]
  );
  const compatibleRows = (action: "start" | "stop" | "restart"): ContainerView[] => selectedRows.filter((container) => {
    if (action === "start") return container.status === "stopped";
    if (action === "stop") return container.status === "running" || container.status === "restarting";
    return container.status === "running";
  });

  const runBulk = (action: "start" | "stop" | "restart"): void => {
    const rows = compatibleRows(action);
    bulkMutation.mutate({ action, targets: rows.map((container) => ({ nodeId: container.nodeId, containerId: container.containerId })) });
  };

  const columns: Column<ContainerView>[] = [
    {
      key: "select",
      ariaLabel: "Select containers",
      header: (
        <input
          type="checkbox"
          aria-label="Select all containers on this page"
          checked={currentRows.length > 0 && currentRows.every((container) => selected.has(`${container.nodeId}:${container.containerId}`))}
          onChange={(event) => {
            const next = new Set(selected);
            for (const container of currentRows) {
              const key = `${container.nodeId}:${container.containerId}`;
              if (event.target.checked) next.add(key);
              else next.delete(key);
            }
            setSelected(next);
          }}
          className="h-4 w-4 accent-brand"
        />
      ),
      className: "w-10 text-center",
      render: (container) => {
        const key = `${container.nodeId}:${container.containerId}`;
        return <input type="checkbox" aria-label={`Select ${container.name}`} checked={selected.has(key)} onChange={(event) => { const next = new Set(selected); if (event.target.checked) next.add(key); else next.delete(key); setSelected(next); }} className="h-4 w-4 accent-brand" />;
      }
    },
    {
      key: "name",
      header: "Container",
      sortValue: (c) => c.name,
      render: (c) => (
        <p className="max-w-[320px] truncate font-mono text-[13px] font-medium text-text" title={c.name}>{c.name}</p>
      )
    },
    { key: "node", header: "Node", sortValue: (c) => c.nodeName, render: (c) => <span className="text-sm">{c.nodeName}</span>, hideBelow: "sm" },
    { key: "client", header: "Organization", sortValue: (c) => c.clientName, render: (c) => <span className="text-sm">{c.clientName}</span>, hideBelow: "sm" },
    { key: "status", header: "State", sortValue: (c) => c.status, render: (c) => <StatusBadge status={c.status} expectedStopped={c.expectedStopped} /> },
    { key: "health", header: "Health", sortValue: (c) => c.health ?? "none", omitWhenEmpty: (c) => !c.health, render: (c) => c.health ? <Badge variant={c.health === "healthy" ? "success" : c.health === "unhealthy" ? "danger" : "warning"}>{c.health}</Badge> : null },
    { key: "cpu", header: "CPU", className: "text-right", sortValue: (c) => c.cpuPercent ?? -1, render: (c) => <span className="font-mono text-xs tabular-nums" title={c.cpuPercent !== null ? `${c.cpuPercent}%` : undefined}>{c.cpuPercent !== null ? `${c.cpuPercent.toFixed(1)}%` : <span className="text-text-subtle">—</span>}</span>, hideBelow: "md" },
    { key: "mem", header: "Memory", className: "text-right", render: (c) => <span className="font-mono text-xs tabular-nums" title={c.memoryUsage ?? undefined}>{compactMemory(c.memoryUsage)}</span>, hideBelow: "md" },
    { key: "restartCount", header: "Restarts", className: "text-right", sortValue: (c) => c.restartCount ?? 0, render: (c) => <span className="font-mono text-xs tabular-nums">{c.restartCount ?? 0}</span>, hideBelow: "lg" },
    { key: "uptime", header: "Uptime", className: "text-right", render: (c) => <span className="font-mono text-xs tabular-nums text-text-muted" title={c.uptime ?? undefined}>{compactUptime(c.uptime)}</span>, hideBelow: "lg" },
    {
      key: "attention",
      header: "Attention",
      sortValue: (c) => c.attention ?? "healthy",
      omitWhenEmpty: (c) => !c.attention || c.attention === "healthy",
      render: (c) => (c.attention && c.attention !== "healthy" ? <AttentionBadge severity={c.attention} /> : null)
    },
    {
      key: "actions",
      header: "",
      className: "w-10 text-right",
      render: (container) => (
        <Menu
          label={`Actions for ${container.name}`}
          items={[
            { label: "View logs", onSelect: () => go({ url: `/admin/containers/${container.nodeId}/${container.containerId}`, label: container.name, type: "container", id: container.containerId }) },
            ...(container.status === "running" ? [{ label: "Restart", onSelect: () => bulkMutation.mutate({ action: "restart", targets: [{ nodeId: container.nodeId, containerId: container.containerId }] }) }, { label: "Stop", tone: "danger" as const, onSelect: () => bulkMutation.mutate({ action: "stop", targets: [{ nodeId: container.nodeId, containerId: container.containerId }] }) }] : []),
            ...(container.status === "stopped" ? [{ label: "Start", onSelect: () => bulkMutation.mutate({ action: "start", targets: [{ nodeId: container.nodeId, containerId: container.containerId }] }) }] : []),
            { label: "Copy ID", onSelect: () => { void navigator.clipboard.writeText(container.containerId); toast.success("Container ID copied"); } }
          ]}
        />
      )
    }
  ];

  const activeFilterCount =
    (status ? 1 : 0) + (nodeId ? 1 : 0) + (clientId ? 1 : 0) + (projectId ? 1 : 0) + (health ? 1 : 0) + (needsAttention ? 1 : 0);

  const groups = [
    {
      id: "status",
      label: "State",
      options: STATUSES.map((s) => ({ value: s, label: s })),
      selected: status ? [status] : []
    },
    {
      id: "node",
      label: "Node",
      options: (refsQuery.data?.nodes ?? []).map((n) => ({ value: n.id, label: n.name })),
      selected: nodeId ? [nodeId] : []
    },
    {
      id: "client",
      label: "Organization",
      options: (refsQuery.data?.clients ?? []).map((c) => ({ value: c.id, label: c.name })),
      selected: clientId ? [clientId] : []
    },
    {
      id: "workload",
      label: "Workload",
      options: (refsQuery.data?.workloads ?? []).map((w) => ({ value: w.id, label: w.name })),
      selected: projectId ? [projectId] : []
    },
    {
      id: "health",
      label: "Health",
      options: [
        { value: "healthy", label: "Healthy" },
        { value: "unhealthy", label: "Unhealthy" },
        { value: "starting", label: "Starting" },
        { value: "none", label: "No healthcheck" }
      ],
      selected: health ? [health] : []
    }
  ];
  const toggles = [{ id: "attention", label: "Needs attention only", checked: needsAttention }];

  const draftToFilters = (draft: FilterDraft): void => {
    const pick = (id: string): string => draft.groups.find((g) => g.id === id)?.selected[0] ?? "";
    const nextStatus = pick("status");
    const nextNode = pick("node");
    const nextClient = pick("client");
    const nextWorkload = pick("workload");
    const nextHealth = pick("health");
    const nextAttention = draft.toggles.find((t) => t.id === "attention")?.checked ?? false;
    setStatus(nextStatus);
    setNodeId(nextNode);
    setClientId(nextClient);
    setProjectId(nextWorkload);
    setHealth(nextHealth);
    setNeedsAttention(nextAttention);
    syncUrl({ status: nextStatus, nodeId: nextNode, clientId: nextClient, projectId: nextWorkload, health: nextHealth, needsAttention: nextAttention ? "1" : "", page: "1" });
  };

  const openSheet = (): void => {
    setSheetCount(query.data?.total ?? null);
    setSheetOpen(true);
  };

  const activeChips = [
    ...(status ? [{ label: status }] : []),
    ...(nodeId ? [{ label: refsQuery.data?.nodes.find((n) => n.id === nodeId)?.name ?? "Node" }] : []),
    ...(projectId ? [{ label: refsQuery.data?.workloads.find((w) => w.id === projectId)?.name ?? "Workload" }] : []),
    ...(health ? [{ label: health }] : []),
    ...(needsAttention ? [{ label: "attention" }] : [])
  ];

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Runtime inventory" title="Containers" count={totalQuery.data?.total ?? query.data?.total ?? 0} description="Every container across all nodes, including unassigned ones." />

      <div>
        <DesktopFilterBar
          search={search}
          onSearchChange={(value) => { setSearch(value); syncUrl({ search: value, page: "1" }); }}
          searchPlaceholder="Search containers…"
          dimensions={[
            { id: "status", label: "State", value: status, options: STATUSES.map((value) => ({ value, label: value })), onChange: (value) => { setStatus(value); syncUrl({ status: value, page: "1" }); } },
            { id: "node", label: "Node", value: nodeId, options: (refsQuery.data?.nodes ?? []).map((node) => ({ value: node.id, label: node.name })), onChange: (value) => { setNodeId(value); syncUrl({ nodeId: value, page: "1" }); } },
            { id: "client", label: "Organization", value: clientId, options: (refsQuery.data?.clients ?? []).map((client) => ({ value: client.id, label: client.name })), onChange: (value) => { setClientId(value); syncUrl({ clientId: value, page: "1" }); } },
            { id: "workload", label: "Workload", value: projectId, options: (refsQuery.data?.workloads ?? []).map((workload) => ({ value: workload.id, label: workload.name })), onChange: (value) => { setProjectId(value); syncUrl({ projectId: value, page: "1" }); } },
            { id: "health", label: "Health", value: health, options: [{ value: "healthy", label: "Healthy" }, { value: "unhealthy", label: "Unhealthy" }, { value: "starting", label: "Starting" }, { value: "none", label: "No healthcheck" }], onChange: (value) => { setHealth(value); syncUrl({ health: value, page: "1" }); } }
          ]}
          toggles={[{ id: "attention", label: "Needs attention", active: needsAttention, onChange: (active) => { setNeedsAttention(active); syncUrl({ needsAttention: active ? "1" : "", page: "1" }); } }]}
          resultCount={query.data?.total ?? 0}
          totalCount={totalQuery.data?.total ?? query.data?.total ?? 0}
          onClearAll={() => { setSearch(""); setStatus(""); setNodeId(""); setClientId(""); setProjectId(""); setHealth(""); setNeedsAttention(false); syncUrl({ search: "", status: "", nodeId: "", clientId: "", projectId: "", health: "", needsAttention: "", page: "1" }); }}
        />
        <div className="w-full md:hidden">
          <MobileFiltersRow count={activeFilterCount} onOpen={openSheet} chips={activeChips} />
        </div>
      </div>

      {selectedRows.length > 0 && (
        <div className="hidden min-h-10 items-center gap-2 rounded-panel border border-selected-border/30 bg-selected/30 px-3 py-2 md:flex" data-bulk-action-bar>
          <span className="font-mono text-xs text-text-muted">{selectedRows.length} selected</span>
          {compatibleRows("restart").length > 0 && <Button size="sm" variant="secondary" onClick={() => setConfirmBulk("restart")}>Restart {compatibleRows("restart").length}</Button>}
          {compatibleRows("stop").length > 0 && <Button size="sm" variant="dangerOutline" onClick={() => setConfirmBulk("stop")}>Stop {compatibleRows("stop").length}</Button>}
          {compatibleRows("start").length > 0 && <Button size="sm" variant="secondary" onClick={() => setConfirmBulk("start")}>Start {compatibleRows("start").length}</Button>}
          <button type="button" onClick={() => setSelected(new Set())} className="ml-auto rounded-control px-2 py-1 text-xs text-text-muted hover:bg-surface-raised hover:text-text">Clear selection</button>
        </div>
      )}

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
        mobileCard={(c) =>
          containerCard(c, () => {
            go({ url: `/admin/containers/${c.nodeId}/${c.containerId}`, label: c.name, type: "container", id: c.containerId });
          })
        }
      />

      <FilterSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        groups={groups}
        toggles={toggles}
        resultCount={sheetCount}
        resultNoun="containers"
        onApply={(draft) => draftToFilters(draft)}
        onReset={() => {
          setStatus("");
          setNodeId("");
          setClientId("");
          setProjectId("");
          setHealth("");
          setNeedsAttention(false);
          syncUrl({ status: "", nodeId: "", clientId: "", projectId: "", health: "", needsAttention: "", page: "1" });
        }}
        onDraftChange={() => setSheetCount(null)}
      />

      <ConfirmDialog
        open={confirmBulk !== null}
        onClose={() => setConfirmBulk(null)}
        onConfirm={() => { if (confirmBulk) runBulk(confirmBulk); }}
        title={`${confirmBulk ? confirmBulk.charAt(0).toUpperCase() + confirmBulk.slice(1) : "Operate on"} ${confirmBulk ? compatibleRows(confirmBulk).length : 0} containers?`}
        impact={`${selectedRows.some((container) => Boolean(container.projectId)) ? "Some selected containers are workload-managed; direct actions are audited and can diverge from their deployment. " : ""}Only containers compatible with this action will be queued.`}
        confirmLabel={confirmBulk ? `${confirmBulk.charAt(0).toUpperCase() + confirmBulk.slice(1)} containers` : "Confirm"}
        danger={confirmBulk === "stop"}
        busy={bulkMutation.isPending}
      />
    </div>
  );
}
