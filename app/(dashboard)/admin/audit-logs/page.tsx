"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetcher";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type AuditPayload = {
  logs: Array<{
    id: string;
    createdAt: string;
    actorEmail: string | null;
    actorRole: "ADMIN" | "CLIENT" | null;
    action: string;
    targetType: string;
    targetId: string | null;
    result: "SUCCESS" | "FAILURE";
    sourceIp: string | null;
  }>;
};

export default function AdminAuditLogsPage(): React.JSX.Element {
  const [search, setSearch] = useState("");

  const query = useQuery({
    queryKey: ["audit-logs", search],
    queryFn: () => apiFetch<AuditPayload>(`/api/admin/audit-logs?q=${encodeURIComponent(search)}`)
  });

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold">Audit logs</h1>
          <p className="text-muted">Immutable history of control-plane actions.</p>
        </div>
        <Input
          className="max-w-xs"
          placeholder="Search action, email, target"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      <Card className="panel">
        <CardHeader>
          <CardTitle>Recent events</CardTitle>
          <CardDescription>Includes login attempts and container actions.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="pb-2">Timestamp</th>
                <th className="pb-2">Actor</th>
                <th className="pb-2">Role</th>
                <th className="pb-2">Action</th>
                <th className="pb-2">Target</th>
                <th className="pb-2">Result</th>
                <th className="pb-2">IP</th>
              </tr>
            </thead>
            <tbody>
              {(query.data?.logs ?? []).map((log) => (
                <tr className="border-t border-border" key={log.id}>
                  <td className="py-3">{new Date(log.createdAt).toLocaleString()}</td>
                  <td className="py-3">{log.actorEmail ?? "system"}</td>
                  <td className="py-3">{log.actorRole ?? "-"}</td>
                  <td className="py-3">{log.action}</td>
                  <td className="py-3">
                    {log.targetType}
                    {log.targetId ? `:${log.targetId}` : ""}
                  </td>
                  <td className="py-3">{log.result}</td>
                  <td className="py-3">{log.sourceIp ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
