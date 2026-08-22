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
import { humanizeAction, timeAgo } from "@/lib/format";
import type { WorkloadSummary } from "@/types/domain";
import { useStoredViewState } from "@/components/navigation/view-state";
import { useResourceNavigation } from "@/components/navigation/navigation-context";
import { FilterSheet, type FilterDraft } from "@/components/mobile/filter-sheet";
import { MobileFiltersRow, workloadCard } from "@/components/mobile/mobile-resource-cards";

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
  nodeFilter: string;
  clientFilter: string;
  stateFilter: string;
  sourceFilter: string;
  needsAttentionOnly: boolean;
};

function applyFilters(workloads: WorkloadSummary[], f: Filters): WorkloadSummary[] {
  let out = workloads;
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
  const [filters, setFilters] = useStoredViewState<Filters>("filters:admin-workloads", {
    nodeFilter: "",
    clientFilter: "",
    stateFilter: "",
    sourceFilter: "",
    needsAttentionOnly: false
  });
  const { nodeFilter, clientFilter, stateFilter, sourceFilter, needsAttentionOnly } = filters;
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetCount, setSheetCount] = useState<number | null>(null);

  const workloadsQuery = useQuery({
    queryKey: ["admin-workloads"],
    queryFn: () => apiFetch<WorkloadsPayload>("/api/admin/workloads"),
    refetchInterval: 20000
  });
  const refsQuery = useQuery({
    queryKey: ["admin-workloads-refs"],
    queryFn: () => apiFetch<RefPayload>("/api/admin/clients-refs")
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
            <span className="block">{humanizeAction(w.lastEvent.action)}</span>
          </span>
        ) : (
          <span className="text-xs text-muted">—</span>
        )
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
    <div className="space-y-6">
      <PageHeader
        eyebrow="Fleet"
        title="Workloads"
        description="Logical services running across your infrastructure."
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

      <DataTable
        columns={columns}
        rows={rows}
        searchableText={(w) => `${w.name} ${w.nodeName} ${w.clientName ?? ""} ${w.description ?? ""} ${w.source}`}
        searchPlaceholder="Search workloads…"
        stateKey="admin-workloads"
        ariaLabel="Workloads"
        toolbar={<>
        <Select
          value={nodeFilter}
          onChange={(e) => setFilters((current) => ({ ...current, nodeFilter: e.target.value }))}
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
          onChange={(e) => setFilters((current) => ({ ...current, clientFilter: e.target.value }))}
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
          onChange={(e) => setFilters((current) => ({ ...current, stateFilter: e.target.value }))}
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
          onChange={(e) => setFilters((current) => ({ ...current, sourceFilter: e.target.value }))}
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
            onChange={(e) => setFilters((current) => ({ ...current, needsAttentionOnly: e.target.checked }))}
            className="accent-accent"
          />
          Needs attention
        </label>
        </>}
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
        onApply={(draft) => setFilters(draftToFilters(draft))}
        onReset={() => setFilters({ nodeFilter: "", clientFilter: "", stateFilter: "", sourceFilter: "", needsAttentionOnly: false })}
        onDraftChange={(draft) => setSheetCount(applyFilters(allWorkloads, draftToFilters(draft)).length)}
      />
    </div>
  );
}
