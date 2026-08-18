"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetcher";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";

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

type ActivityPayload = { logs: AuditEntry[]; total: number };

export default function AdminActivityPage(): React.JSX.Element {
  const [actionFilter, setActionFilter] = useState("");
  const [resultFilter, setResultFilter] = useState("");
  const [selected, setSelected] = useState<AuditEntry | null>(null);

  const query = useQuery({
    queryKey: ["admin-activity", actionFilter, resultFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (actionFilter) params.set("action", actionFilter);
      if (resultFilter) params.set("result", resultFilter);
      params.set("limit", "200");
      return apiFetch<ActivityPayload>(`/api/admin/audit-logs?${params.toString()}`);
    },
    refetchInterval: 15000
  });

  const columns: Column<AuditEntry>[] = [
    {
      key: "action",
      header: "Event",
      sortValue: (a) => a.action,
      render: (a) => (
        <div>
          <p className="font-medium">{a.humanized}</p>
          <p className="text-xs text-muted">{a.action}</p>
        </div>
      )
    },
    {
      key: "actor",
      header: "Actor",
      render: (a) => <span className="text-sm">{a.actorEmail ?? "system"}</span>,
      hideBelow: "sm"
    },
    {
      key: "result",
      header: "Result",
      sortValue: (a) => a.result,
      render: (a) => <Badge variant={a.result === "SUCCESS" ? "success" : "danger"}>{a.result.toLowerCase()}</Badge>
    },
    {
      key: "target",
      header: "Resource",
      render: (a) => <span className="text-xs text-muted">{a.targetType}</span>,
      hideBelow: "md"
    },
    {
      key: "time",
      header: "When",
      sortValue: (a) => a.createdAt,
      render: (a) => <span className="text-xs text-muted">{formatDateTime(a.createdAt)}</span>
    },
    {
      key: "details",
      header: "",
      render: (a) => (
        <Button size="sm" variant="secondary" onClick={() => setSelected(a)}>
          Details
        </Button>
      )
    }
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Activity</h1>
        <p className="text-muted">What happened across the platform.</p>
      </div>

      <div className="flex flex-wrap gap-2">
        <input
          type="search"
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          placeholder="Filter by action or actor…"
          aria-label="Filter activity"
          className="w-64 rounded-md border border-border bg-panelAlt px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-accent"
        />
        <select
          value={resultFilter}
          onChange={(e) => setResultFilter(e.target.value)}
          aria-label="Filter by result"
          className="rounded-md border border-border bg-panelAlt px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-accent"
        >
          <option value="">All results</option>
          <option value="SUCCESS">Success</option>
          <option value="FAILURE">Failure</option>
        </select>
      </div>

      <DataTable
        columns={columns}
        rows={query.data?.logs ?? []}
        loading={query.isLoading}
        error={query.isError ? "Failed to load activity" : null}
        emptyTitle="No activity"
        emptyBody="Actions performed on the platform will appear here."
        rowKey={(a) => a.id}
      />

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
            <Detail label="Humanized" value={selected.humanized} />
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
                <dd className="mt-1 rounded border border-border bg-black/40 p-2 font-mono text-xs text-slate-200">
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
