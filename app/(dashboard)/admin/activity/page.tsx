"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetcher";
import { Badge } from "@/components/ui/badge";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { formatDateTime, humanizeAction } from "@/lib/format";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { ActivityTimeline, type TimelineEvent } from "@/components/activity/activity-timeline";

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
    syncUrl({ q, result, nodeId, clientId });
  }, [q, result, nodeId, clientId, syncUrl]);

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

  const hasDeepLink = Boolean(containerId || projectId);

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Audit trail" title="Activity" description="What happened across the platform." />

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

      <div className="flex flex-wrap gap-2">
        <Input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search events, actors…"
          aria-label="Search activity"
          className="w-64"
        />
        <Select
          value={result}
          onChange={(e) => setResult(e.target.value)}
          aria-label="Filter by result"
          className="w-auto min-w-36"
        >
          <option value="">All results</option>
          <option value="SUCCESS">Success</option>
          <option value="FAILURE">Failure</option>
        </Select>
        <Select
          value={nodeId}
          onChange={(e) => setNodeId(e.target.value)}
          aria-label="Filter by node"
          className="w-auto min-w-40"
        >
          <option value="">All nodes</option>
          {(refsQuery.data?.nodes ?? []).map((n) => (
            <option key={n.id} value={n.id}>{n.name}</option>
          ))}
        </Select>
        <Select
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          aria-label="Filter by client"
          className="w-auto min-w-40"
        >
          <option value="">All clients</option>
          {(refsQuery.data?.clients ?? []).map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </Select>
      </div>

      <ActivityTimeline
        events={query.data?.logs ?? []}
        onSelect={(event: TimelineEvent) => setSelected(event as AuditEntry)}
        loading={query.isLoading}
        error={query.isError ? "Failed to load activity" : null}
        emptyTitle="No activity"
        emptyBody="Actions performed on the platform will appear here."
      />

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
