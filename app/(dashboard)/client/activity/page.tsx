"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetcher";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatDateTime } from "@/lib/format";
import { PageHeader } from "@/components/ui/page-header";

type AuditEvent = {
  id: string;
  createdAt: string;
  actorEmail: string | null;
  actorRole: string | null;
  action: string;
  humanized: string;
  targetType: string;
  targetId: string | null;
  result: string;
};

type ActivityPayload = { events: AuditEvent[]; total: number };

export default function ClientActivityPage(): React.JSX.Element {
  const [queryText, setQueryText] = useState("");

  const query = useQuery({
    queryKey: ["client-activity"],
    queryFn: () => apiFetch<ActivityPayload>("/api/client/activity?limit=200"),
    refetchInterval: 15000
  });

  const columns: Column<AuditEvent>[] = [
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
      render: (a) => (
        <Badge variant={a.result === "SUCCESS" ? "success" : "danger"}>{a.result.toLowerCase()}</Badge>
      )
    },
    {
      key: "time",
      header: "When",
      sortValue: (a) => a.createdAt,
      render: (a) => <span className="text-xs text-muted">{formatDateTime(a.createdAt)}</span>
    }
  ];

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Audit trail" title="Activity" description="Recent actions on the services assigned to you." />

      <DataTable
        columns={columns}
        rows={query.data?.events ?? []}
        searchableText={(a) => `${a.humanized} ${a.action} ${a.actorEmail ?? ""} ${a.targetType}`}
        searchPlaceholder="Search activity…"
        loading={query.isLoading}
        error={query.isError ? "Failed to load activity" : null}
        emptyTitle="No activity yet"
        emptyBody="Actions on your workloads and containers will appear here."
        rowKey={(a) => a.id}
      />
    </div>
  );
}
