"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Compass } from "lucide-react";
import { toast } from "sonner";
import { apiFetch } from "@/lib/fetcher";
import { Button } from "@/components/ui/button";
import { AttentionBadge } from "@/components/ui/attention-badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { PageHeader } from "@/components/ui/page-header";
import { compactMemory, humanizeAction, timeAgo } from "@/lib/format";
import type { WorkloadSummary } from "@/types/domain";
import { useResourceNavigation } from "@/components/navigation/navigation-context";
import { FilterSheet, type FilterDraft } from "@/components/mobile/filter-sheet";
import { MobileFiltersRow, workloadCard } from "@/components/mobile/mobile-resource-cards";
import { DesktopFilterBar } from "@/components/ui/desktop-filter-bar";
import { Menu } from "@/components/ui/menu";
import { Input } from "@/components/ui/input";

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

type Filters = {
  search: string;
  nodeFilter: string;
  clientFilter: string;
  stateFilter: string;
  sourceFilter: string;
  needsAttentionOnly: boolean;
};

function applyFilters(workloads: WorkloadSummary[], f: Filters): WorkloadSummary[] {
  let out = workloads;
  if (f.search) {
    const query = f.search.toLowerCase();
    out = out.filter((workload) => `${workload.name} ${workload.nodeName} ${workload.clientName ?? ""} ${workload.description ?? ""} ${workload.source}`.toLowerCase().includes(query));
  }
  if (f.nodeFilter) out = out.filter((w) => w.nodeId === f.nodeFilter);
  if (f.clientFilter) out = out.filter((w) => w.clientId === f.clientFilter);
  if (f.stateFilter) out = out.filter((w) => w.health === f.stateFilter);
  if (f.sourceFilter) out = out.filter((w) => w.source === f.sourceFilter);
  if (f.needsAttentionOnly) out = out.filter((w) => healthAttention(w) === "critical" || healthAttention(w) === "warning");
  return out;
}

function activeCount(f: Filters): number {
  return (
    (f.nodeFilter ? 1 : 0) +
    (f.clientFilter ? 1 : 0) +
    (f.stateFilter ? 1 : 0) +
    (f.sourceFilter ? 1 : 0) +
    (f.needsAttentionOnly ? 1 : 0)
  );
}

export default function AdminWorkloadsPage(): React.JSX.Element {
  const go = useResourceNavigation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const [filters, setFilters] = useState<Filters>({
    search: searchParams.get("search") ?? "",
    nodeFilter: searchParams.get("nodeId") ?? "",
    clientFilter: searchParams.get("clientId") ?? "",
    stateFilter: searchParams.get("state") ?? "",
    sourceFilter: searchParams.get("source") ?? "",
    needsAttentionOnly: searchParams.get("needsAttention") === "1"
  });
  const { search, nodeFilter, clientFilter, stateFilter, sourceFilter, needsAttentionOnly } = filters;
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetCount, setSheetCount] = useState<number | null>(null);

  const syncUrl = useCallback((next: Filters) => {
    const params = new URLSearchParams();
    if (next.search) params.set("search", next.search);
    if (next.nodeFilter) params.set("nodeId", next.nodeFilter);
    if (next.clientFilter) params.set("clientId", next.clientFilter);
    if (next.stateFilter) params.set("state", next.stateFilter);
    if (next.sourceFilter) params.set("source", next.sourceFilter);
    if (next.needsAttentionOnly) params.set("needsAttention", "1");
    const query = params.toString();
    router.push(query ? `/admin/workloads?${query}` : "/admin/workloads", { scroll: false });
  }, [router]);

  const updateFilters = useCallback((patch: Partial<Filters>) => {
    setFilters((current) => {
      const next = { ...current, ...patch };
      syncUrl(next);
      return next;
    });
  }, [syncUrl]);

  useEffect(() => {
    const next: Filters = {
      search: searchParams.get("search") ?? "",
      nodeFilter: searchParams.get("nodeId") ?? "",
      clientFilter: searchParams.get("clientId") ?? "",
      stateFilter: searchParams.get("state") ?? "",
      sourceFilter: searchParams.get("source") ?? "",
      needsAttentionOnly: searchParams.get("needsAttention") === "1"
    };
    setFilters((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
  }, [searchParams]);

  const workloadsQuery = useQuery({
    queryKey: ["admin-workloads"],
    queryFn: () => apiFetch<WorkloadsPayload>("/api/admin/workloads"),
    refetchInterval: 20000
  });
  const refsQuery = useQuery({
    queryKey: ["admin-workloads-refs"],
    queryFn: () => apiFetch<RefPayload>("/api/admin/clients-refs")
  });
  const restartMutation = useMutation({
    mutationFn: (id: string) => apiFetch<{ total: number; failures: Array<{ reason: string }> }>(`/api/admin/workloads/${id}/restart`, { method: "POST" }),
    onSuccess: async (data) => {
      if (data.failures.length > 0) toast.warning(`${data.total - data.failures.length}/${data.total} restarts queued`);
      else toast.success(`Restart queued for ${data.total} containers`);
      await queryClient.invalidateQueries({ queryKey: ["admin-workloads"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Restart failed")
  });

  const allWorkloads = workloadsQuery.data?.workloads ?? [];

  const rows = useMemo(() => {
    // Default view surfaces problems first (§5): explicit severity rank, then
    // alphabetical — never resorts purely on a fluctuating metric like CPU%.
    return [...applyFilters(allWorkloads, filters)].sort((a, b) => {
      const diff = ATTENTION_RANK[healthAttention(a)] - ATTENTION_RANK[healthAttention(b)];
      if (diff !== 0) return diff;
      return a.name.localeCompare(b.name);
    });
  }, [allWorkloads, filters]);

  const columns: Column<WorkloadSummary>[] = [
    {
      key: "name",
      header: "Workload",
      sortValue: (w) => w.name,
      render: (w) => (
        <p className="truncate font-medium text-text" title={w.name}>{w.name}</p>
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
      key: "source",
      header: "Type",
      sortValue: (w) => w.source,
      render: (w) => <span className="text-sm text-muted">{{ MANUAL: "Manual", COMPOSE: "External Compose", MANAGED: "Managed" }[w.source] ?? w.source}</span>,
      hideBelow: "md"
    },
    {
      key: "status",
      header: "Containers",
      sortValue: (w) => w.runningContainers,
      render: (w) => (
        <span className="font-mono text-sm">
          {w.runningContainers}/{w.totalContainers} running
          {w.intentionallyStoppedContainers > 0 && (
            <span className="text-text-muted"> · {w.intentionallyStoppedContainers} stopped</span>
          )}
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
      omitWhenEmpty: (w) => healthAttention(w) === "healthy",
      render: (w) => {
        const a = healthAttention(w);
        return a === "healthy" ? null : <AttentionBadge severity={a} />;
      },
      hideBelow: "md"
    },
    {
      key: "cpu",
      header: "CPU",
      className: "text-right",
      hideBelow: "md",
      render: (w) => <span className="font-mono text-xs tabular-nums text-text-muted">{w.cpuPercent !== null ? `${w.cpuPercent.toFixed(1)}%` : "—"}</span>
    },
    {
      key: "memory",
      header: "Memory",
      className: "text-right",
      hideBelow: "md",
      render: (w) => <span className="font-mono text-xs tabular-nums text-text-muted" title={w.memoryUsage ?? undefined}>{compactMemory(w.memoryUsage)}</span>
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
            <span className="block">{humanizeAction(w.lastEvent.action)}</span>
          </span>
        ) : (
          <span className="text-xs text-muted">—</span>
        )
    },
    {
      key: "actions",
      header: "",
      className: "w-10 text-right",
      render: (workload) => <Menu label={`Actions for ${workload.name}`} items={[
        { label: "Open workload", onSelect: () => go({ url: `/admin/workloads/${workload.id}`, label: workload.name, type: "workload", id: workload.id }) },
        ...(workload.totalContainers > 0 ? [{ label: "Restart workload", onSelect: () => restartMutation.mutate(workload.id) }] : []),
        { label: "View activity", onSelect: () => router.push(`/admin/activity?projectId=${workload.id}`) },
        { label: "Copy ID", onSelect: () => { void navigator.clipboard.writeText(workload.id); } }
      ]} />
    }
  ];

  const nodeOptions = (refsQuery.data?.nodes ?? []).map((n) => ({ value: n.id, label: n.name }));
  const clientOptions = (refsQuery.data?.clients ?? []).map((c) => ({ value: c.id, label: c.name }));

  const groups = useMemo(
    () => [
      { id: "node", label: "Node", options: nodeOptions, selected: nodeFilter ? [nodeFilter] : [] },
      {
        id: "state",
        label: "State",
        options: [
          { value: "healthy", label: "Healthy" },
          { value: "degraded", label: "Degraded" },
          { value: "down", label: "Down" },
          { value: "unknown", label: "Unknown" }
        ],
        selected: stateFilter ? [stateFilter] : []
      },
      {
        id: "source",
        label: "Type",
        options: [
          { value: "MANUAL", label: "Manual" },
          { value: "COMPOSE", label: "External Compose" },
          { value: "MANAGED", label: "Managed" }
        ],
        selected: sourceFilter ? [sourceFilter] : []
      },
      { id: "client", label: "Client", options: clientOptions, selected: clientFilter ? [clientFilter] : [] }
    ],
    [nodeOptions, clientOptions, nodeFilter, stateFilter, sourceFilter, clientFilter]
  );

  const toggles = [{ id: "attention", label: "Needs attention only", checked: needsAttentionOnly }];

  const draftToFilters = (draft: FilterDraft): Filters => {
    const pick = (id: string): string => draft.groups.find((g) => g.id === id)?.selected[0] ?? "";
    return {
      search,
      nodeFilter: pick("node"),
      stateFilter: pick("state"),
      sourceFilter: pick("source"),
      clientFilter: pick("client"),
      needsAttentionOnly: draft.toggles.find((t) => t.id === "attention")?.checked ?? false
    };
  };

  const openSheet = (): void => {
    setSheetCount(applyFilters(allWorkloads, filters).length);
    setSheetOpen(true);
  };

  const activeChips = [
    ...(nodeFilter ? [{ label: refsQuery.data?.nodes.find((n) => n.id === nodeFilter)?.name ?? "Node" }] : []),
    ...(stateFilter ? [{ label: stateFilter }] : []),
    ...(sourceFilter ? [{ label: sourceFilter.toLowerCase() }] : [])
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Fleet"
        title="Workloads"
        count={allWorkloads.length}
        actions={<>
          <Button variant="secondary" onClick={() => router.push("/admin/compose")}>
            <Compass size={14} className="mr-2" />
            Discover Compose projects
          </Button>
          <Button size="sm" onClick={() => router.push("/admin/workloads/new")}>
            New workload
          </Button>
        </>}
      />

      <DesktopFilterBar
        search={search}
        onSearchChange={(value) => updateFilters({ search: value })}
        searchPlaceholder="Search workloads…"
        dimensions={[
          { id: "node", label: "Node", value: nodeFilter, options: nodeOptions, onChange: (value) => updateFilters({ nodeFilter: value }) },
          { id: "client", label: "Client", value: clientFilter, options: clientOptions, onChange: (value) => updateFilters({ clientFilter: value }) },
          { id: "state", label: "State", value: stateFilter, options: [{ value: "healthy", label: "Healthy" }, { value: "degraded", label: "Degraded" }, { value: "down", label: "Down" }, { value: "unknown", label: "Unknown" }], onChange: (value) => updateFilters({ stateFilter: value }) },
          { id: "source", label: "Type", value: sourceFilter, options: [{ value: "MANUAL", label: "Manual" }, { value: "COMPOSE", label: "External Compose" }, { value: "MANAGED", label: "Managed" }], onChange: (value) => updateFilters({ sourceFilter: value }) }
        ]}
        toggles={[{ id: "attention", label: "Needs attention", active: needsAttentionOnly, onChange: (active) => updateFilters({ needsAttentionOnly: active }) }]}
        resultCount={rows.length}
        totalCount={allWorkloads.length}
        onClearAll={() => updateFilters({ search: "", nodeFilter: "", clientFilter: "", stateFilter: "", sourceFilter: "", needsAttentionOnly: false })}
      />

      {/* Mobile keeps its card/search/filter-sheet system. */}
      <div className="md:hidden">
        <Input type="search" value={search} onChange={(event) => updateFilters({ search: event.target.value })} placeholder="Search workloads…" aria-label="Search workloads…" />
      </div>

      <select aria-label="Filter by node" value={nodeFilter} onChange={(event) => updateFilters({ nodeFilter: event.target.value })} className="sr-only">
        <option value="">All nodes</option>{nodeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>

      <DataTable
        columns={columns}
        rows={rows}
        stateKey="admin-workloads"
        ariaLabel="Workloads"
        mobileToolbar={
          <MobileFiltersRow
            count={activeCount(filters)}
            onOpen={openSheet}
            chips={activeChips}
          />
        }
        mobileCard={(w) =>
          workloadCard(w, () => {
            go({ url: `/admin/workloads/${w.id}`, label: w.name, type: "workload", id: w.id });
          })
        }
        loading={workloadsQuery.isLoading}
        error={workloadsQuery.isError ? "Failed to load workloads" : null}
        emptyTitle="No workloads yet"
        emptyBody="Create a stack and attach containers to group them into a logical workload."
        onRowClick={(w) => {
          go({ url: `/admin/workloads/${w.id}`, label: w.name, type: "workload", id: w.id });
        }}
        rowKey={(w) => w.id}
      />

      <FilterSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        groups={groups}
        toggles={toggles}
        resultCount={sheetCount}
        resultNoun="workloads"
        onApply={(draft) => updateFilters(draftToFilters(draft))}
        onReset={() => updateFilters({ nodeFilter: "", clientFilter: "", stateFilter: "", sourceFilter: "", needsAttentionOnly: false })}
        onDraftChange={(draft) => setSheetCount(applyFilters(allWorkloads, draftToFilters(draft)).length)}
      />
    </div>
  );
}
