"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetcher";
import { Badge } from "@/components/ui/badge";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDateTime, humanizeAction } from "@/lib/format";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { ActivityTimeline, type TimelineEvent } from "@/components/activity/activity-timeline";
import { MobileActivityList } from "@/components/mobile/mobile-activity-list";
import { FilterSheet, type FilterDraft } from "@/components/mobile/filter-sheet";
import { MobileFiltersRow } from "@/components/mobile/mobile-resource-cards";
import { DesktopFilterBar } from "@/components/ui/desktop-filter-bar";

type AuditEntry = {
  id: string;
  createdAt: string;
  actorEmail: string | null;
  actorRole: string | null;
  action: string;
  humanized: string;
  targetType: string;
  targetId: string | null;
  result: string;
  sourceIp: string | null;
  clientAccountId: string | null;
  metadata: Record<string, unknown> | null;
};

type ActivityPayload = { logs: AuditEntry[]; total: number; page: number; limit: number; pageCount: number };
type RefPayload = { nodes: Array<{ id: string; name: string }>; clients: Array<{ id: string; name: string }> };

const PAGE_SIZE = 25;

export default function AdminActivityPage(): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [selected, setSelected] = useState<AuditEntry | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetCount, setSheetCount] = useState<number | null>(null);

  const [q, setQ] = useState(searchParams.get("q") ?? "");
  const [result, setResult] = useState(searchParams.get("result") ?? "");
  const [nodeId, setNodeId] = useState(searchParams.get("nodeId") ?? "");
  const [clientId, setClientId] = useState(searchParams.get("clientId") ?? "");
  const containerId = searchParams.get("containerId") ?? "";
  const projectId = searchParams.get("projectId") ?? "";
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";
  const page = Math.max(Number(searchParams.get("page") ?? "1"), 1);

  const syncUrl = useCallback(
    (patch: Record<string, string>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value) params.set(key, value);
        else params.delete(key);
      }
      router.replace(`/admin/activity?${params.toString()}`, { scroll: false });
    },
    [router, searchParams]
  );

  useEffect(() => {
    setQ(searchParams.get("q") ?? "");
    setResult(searchParams.get("result") ?? "");
    setNodeId(searchParams.get("nodeId") ?? "");
    setClientId(searchParams.get("clientId") ?? "");
  }, [searchParams]);

  const query = useQuery({
    queryKey: ["admin-activity", { q, result, nodeId, clientId, containerId, projectId, from, to, page }],
    queryFn: () => {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (result) params.set("result", result);
      if (nodeId) params.set("nodeId", nodeId);
      if (clientId) params.set("clientId", clientId);
      if (containerId) params.set("containerId", containerId);
      if (projectId) params.set("projectId", projectId);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      params.set("page", String(page));
      params.set("limit", String(PAGE_SIZE));
      return apiFetch<ActivityPayload>(`/api/admin/audit-logs?${params.toString()}`);
    },
    refetchInterval: 15000
  });

  const refsQuery = useQuery({
    queryKey: ["admin-activity-refs"],
    queryFn: () => apiFetch<RefPayload>("/api/admin/clients-refs")
  });
  const totalQuery = useQuery({
    queryKey: ["admin-activity-total"],
    queryFn: () => apiFetch<ActivityPayload>("/api/admin/audit-logs?page=1&limit=1"),
    refetchInterval: 30_000
  });

  const hasDeepLink = Boolean(containerId || projectId);

  // Mobile header Filter pill (design §05) dispatches this event.
  useEffect(() => {
    const open = (): void => {
      setSheetCount(query.data?.total ?? null);
      setSheetOpen(true);
    };
    window.addEventListener("noderaft:open-activity-filter", open);
    return () => window.removeEventListener("noderaft:open-activity-filter", open);
  });

  const groups = [
    {
      id: "result",
      label: "Result",
      options: [
        { value: "SUCCESS", label: "Success" },
        { value: "FAILURE", label: "Failure" }
      ],
      selected: result ? [result] : []
    },
    {
      id: "node",
      label: "Node",
      options: (refsQuery.data?.nodes ?? []).map((n) => ({ value: n.id, label: n.name })),
      selected: nodeId ? [nodeId] : []
    },
    {
      id: "client",
      label: "Client",
      options: (refsQuery.data?.clients ?? []).map((c) => ({ value: c.id, label: c.name })),
      selected: clientId ? [clientId] : []
    }
  ];

  const applyDraft = (draft: FilterDraft): void => {
    const pick = (id: string): string => draft.groups.find((g) => g.id === id)?.selected[0] ?? "";
    const nextResult = pick("result");
    const nextNode = pick("node");
    const nextClient = pick("client");
    setResult(nextResult);
    setNodeId(nextNode);
    setClientId(nextClient);
    syncUrl({ result: nextResult, nodeId: nextNode, clientId: nextClient, page: "1" });
  };

  const activeFilterCount = (q ? 1 : 0) + (result ? 1 : 0) + (nodeId ? 1 : 0) + (clientId ? 1 : 0);

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Audit trail" title="Activity" count={totalQuery.data?.total ?? query.data?.total ?? 0} description="An ordered audit trail of operator and system changes." />

      {hasDeepLink && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-panelAlt px-3 py-2 text-sm">
          <span className="text-muted">Filtering:</span>
          {containerId && <Badge>container {containerId.slice(0, 12)}</Badge>}
          {projectId && <Badge>workload</Badge>}
          <button type="button" className="text-xs text-accent hover:underline" onClick={() => router.replace("/admin/activity")}>
            Clear
          </button>
        </div>
      )}

      <DesktopFilterBar
        search={q}
        onSearchChange={(value) => { setQ(value); syncUrl({ q: value, page: "1" }); }}
        searchPlaceholder="Search events, actors…"
        dimensions={[
          { id: "result", label: "Result", value: result, options: [{ value: "SUCCESS", label: "Success" }, { value: "FAILURE", label: "Failure" }], onChange: (value) => { setResult(value); syncUrl({ result: value, page: "1" }); } },
          { id: "node", label: "Node", value: nodeId, options: (refsQuery.data?.nodes ?? []).map((node) => ({ value: node.id, label: node.name })), onChange: (value) => { setNodeId(value); syncUrl({ nodeId: value, page: "1" }); } },
          { id: "client", label: "Client", value: clientId, options: (refsQuery.data?.clients ?? []).map((client) => ({ value: client.id, label: client.name })), onChange: (value) => { setClientId(value); syncUrl({ clientId: value, page: "1" }); } }
        ]}
        resultCount={query.data?.total ?? 0}
        totalCount={totalQuery.data?.total ?? query.data?.total ?? 0}
        onClearAll={() => { setQ(""); setResult(""); setNodeId(""); setClientId(""); syncUrl({ q: "", result: "", nodeId: "", clientId: "", page: "1" }); }}
      />

      <div className="md:hidden">
        <Input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search events, actors…"
          aria-label="Search activity"
          className="w-full"
        />
        <div className="mt-2">
          <MobileFiltersRow
            count={activeFilterCount}
            onOpen={() => {
              setSheetCount(query.data?.total ?? null);
              setSheetOpen(true);
            }}
            chips={[
              ...(result ? [{ label: result.toLowerCase() }] : []),
              ...(nodeId ? [{ label: refsQuery.data?.nodes.find((n) => n.id === nodeId)?.name ?? "Node" }] : []),
              ...(clientId ? [{ label: refsQuery.data?.clients.find((c) => c.id === clientId)?.name ?? "Client" }] : [])
            ]}
          />
        </div>
      </div>

      <div className="max-md:hidden">
      <ActivityTimeline
        events={query.data?.logs ?? []}
        onSelect={(event: TimelineEvent) => setSelected(event as AuditEntry)}
        loading={query.isLoading}
        error={query.isError ? "Failed to load activity" : null}
        emptyTitle="No activity"
        emptyBody="Actions performed on the platform will appear here."
      />
      </div>
      <div className="md:hidden">
        {query.isLoading ? (
          <div className="h-40 animate-pulse rounded-panel border border-border bg-surface-deck" />
        ) : query.isError ? (
          <p className="rounded-panel border border-critical/30 bg-critical/5 p-4 text-sm text-critical-foreground">Failed to load activity.</p>
        ) : (
          <MobileActivityList events={query.data?.logs ?? []} onSelect={(event) => setSelected(event as AuditEntry)} />
        )}
      </div>

      {(query.data?.pageCount ?? 0) > 1 && (
        <Pagination
          start={(page - 1) * PAGE_SIZE + 1}
          end={Math.min(page * PAGE_SIZE, query.data?.total ?? 0)}
          total={query.data?.total ?? 0}
          page={page}
          pageCount={query.data?.pageCount ?? 1}
          onPageChange={(p) => syncUrl({ page: String(p) })}
        />
      )}

      <Modal
        open={selected !== null}
        onClose={() => setSelected(null)}
        title="Event details"
        size="md"
        footer={<Button variant="secondary" onClick={() => setSelected(null)}>Close</Button>}
      >
        {selected && (
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <Detail label="Action" value={selected.action} />
            <Detail label="Event" value={humanizeAction(selected.action)} />
            <Detail label="Actor" value={selected.actorEmail ?? "system"} />
            <Detail label="Role" value={selected.actorRole ?? "—"} />
            <Detail label="Result" value={selected.result} />
            <Detail label="Target type" value={selected.targetType} />
            <Detail label="Target id" value={selected.targetId ?? "—"} />
            <Detail label="Source IP" value={selected.sourceIp ?? "—"} />
            <Detail label="Timestamp" value={formatDateTime(selected.createdAt)} />
            {selected.metadata && (
              <div className="col-span-2">
                <dt className="text-xs uppercase tracking-wide text-muted">Metadata</dt>
                <dd className="mt-1 rounded border border-border bg-surface-hull/75 p-2 font-mono text-xs text-text">
                  {JSON.stringify(selected.metadata, null, 2)}
                </dd>
              </div>
            )}
          </dl>
        )}
      </Modal>

      <FilterSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        groups={groups}
        resultCount={sheetCount}
        resultNoun="events"
        onApply={(draft) => applyDraft(draft)}
        onReset={() => {
          setResult("");
          setNodeId("");
          setClientId("");
          syncUrl({ result: "", nodeId: "", clientId: "", page: "1" });
        }}
        onDraftChange={() => setSheetCount(null)}
      />
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-0.5 break-all">{value}</dd>
    </div>
  );
}
