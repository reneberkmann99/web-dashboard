"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetcher";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatBytes, timeAgo } from "@/lib/format";
import type { RuntimeContainer } from "@/server/services/node-agent/types";

type NodeDetailPayload = {
  node: {
    id: string;
    name: string;
    hostname: string;
    status: string;
    isActive: boolean;
    lastHeartbeatAt: string | null;
    agentVersion: string | null;
    dockerVersion: string | null;
    osInfo: Record<string, unknown> | null;
    systemInfo: Record<string, unknown> | null;
    containerCount: number;
    runningCount: number;
    unhealthyCount: number;
    stoppedCount: number;
    storageSummary: Array<{ type: string; totalCount: number; active: number; size: string; reclaimable: string }>;
    projects: Array<{ id: string; name: string; slug: string; clientAccount: { name: string }; _count: { containers: number } }>;
  };
  activity: Array<{ id: string; action: string; actorEmail: string | null; result: string; createdAt: string }>;
};

type ContainersPayload = { containers: RuntimeContainer[] };

const TABS = ["Overview", "Workloads", "Containers", "Activity"] as const;

export default function AdminNodeDetailPage(): React.JSX.Element {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [tab, setTab] = useState<(typeof TABS)[number]>("Overview");

  const detail = useQuery({
    queryKey: ["node", params.id],
    queryFn: () => apiFetch<NodeDetailPayload>(`/api/admin/nodes/${params.id}`),
    refetchInterval: 15000
  });

  const containersQuery = useQuery({
    queryKey: ["node-containers", params.id],
    queryFn: () => apiFetch<ContainersPayload>(`/api/admin/nodes/${params.id}/containers`),
    refetchInterval: 15000,
    enabled: tab === "Containers"
  });

  if (detail.isLoading) return <div className="h-40 animate-pulse rounded-lg bg-panelAlt" />;
  if (detail.isError || !detail.data) return <p className="text-sm text-red-400">Failed to load node.</p>;

  const { node, activity } = detail.data;
  const offline = node.status === "OFFLINE" || node.status === "UNKNOWN";
  const stale = !offline && node.lastHeartbeatAt && Date.now() - new Date(node.lastHeartbeatAt).getTime() > 5 * 60_000;

  const containerColumns: Column<RuntimeContainer>[] = [
    {
      key: "name",
      header: "Container",
      render: (c) => (
        <div>
          <p className="font-medium">{c.name}</p>
          <p className="text-xs text-muted">{c.id.slice(0, 12)}</p>
        </div>
      )
    },
    { key: "status", header: "Status", render: (c) => <Badge variant={c.status === "running" ? "success" : c.status === "stopped" ? "danger" : "warning"}>{c.status}</Badge> },
    { key: "cpu", header: "CPU", render: (c) => <span className="text-sm">{c.cpuPercent !== null ? `${c.cpuPercent}%` : "—"}</span>, hideBelow: "sm" },
    { key: "mem", header: "Memory", render: (c) => <span className="text-sm">{c.memoryUsage ?? "—"}</span>, hideBelow: "sm" },
    { key: "ports", header: "Ports", render: (c) => <span className="text-xs text-muted">{c.ports}</span>, hideBelow: "md" }
  ];

  return (
    <div className="space-y-6">
      <div>
        <button type="button" onClick={() => router.push("/admin/nodes")} className="mb-1 text-sm text-accent hover:underline">
          ← Nodes
        </button>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-semibold">{node.name}</h1>
          <Badge variant={offline ? "danger" : stale ? "warning" : "success"}>
            {offline ? "offline" : stale ? "stale heartbeat" : "online"}
          </Badge>
          {!node.isActive && <Badge>disabled</Badge>}
          <button
            type="button"
            onClick={() => router.push(`/admin/activity?nodeId=${params.id}`)}
            className="ml-auto text-sm text-accent hover:underline"
          >
            View activity →
          </button>
        </div>
        <p className="text-muted">{node.hostname}</p>
        {offline && (
          <p className="mt-2 rounded-lg border border-danger/30 bg-danger/5 p-3 text-sm text-red-300">
            This node is not responding. Last heartbeat: {timeAgo(node.lastHeartbeatAt)}. Check the agent container or
            host connectivity.
          </p>
        )}
      </div>

      {tab === "Overview" && (
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="rounded-lg border border-border bg-panel p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">Host</h2>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <Stat label="State" value={node.status.toLowerCase()} />
              <Stat label="Last heartbeat" value={timeAgo(node.lastHeartbeatAt)} />
              <Stat label="Agent version" value={node.agentVersion ?? "—"} />
              <Stat label="Docker version" value={node.dockerVersion ?? "—"} />
              <Stat label="OS" value={String(node.osInfo?.os ?? "—")} />
              <Stat label="Architecture" value={String(node.osInfo?.arch ?? "—")} />
              <Stat label="CPU cores" value={String(node.systemInfo?.cpuCount ?? "—")} />
              <Stat label="Memory" value={formatBytes(Number(node.systemInfo?.totalMemBytes ?? 0))} />
            </dl>
          </div>
          <div className="rounded-lg border border-border bg-panel p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">Containers</h2>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <Stat label="Total" value={String(node.containerCount)} />
              <Stat label="Running" value={String(node.runningCount)} />
              <Stat label="Stopped" value={String(node.stoppedCount)} />
              <Stat label="Unhealthy" value={String(node.unhealthyCount)} />
            </dl>
          </div>

          <div className="rounded-lg border border-border bg-panel p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">Docker storage</h2>
            {node.storageSummary.length === 0 ? (
              <p className="text-sm text-muted">Storage summary unavailable.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className="pb-2">Type</th>
                    <th className="pb-2">Total</th>
                    <th className="pb-2">Active</th>
                    <th className="pb-2">Size</th>
                    <th className="pb-2">Reclaimable</th>
                  </tr>
                </thead>
                <tbody>
                  {node.storageSummary.map((s) => (
                    <tr key={s.type} className="border-t border-border">
                      <td className="py-1.5 capitalize">{s.type.replace(/^Local /, "").toLowerCase()}</td>
                      <td className="py-1.5">{s.totalCount}</td>
                      <td className="py-1.5">{s.active}</td>
                      <td className="py-1.5">{s.size}</td>
                      <td className="py-1.5">{s.reclaimable}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="rounded-lg border border-border bg-panel p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">Workloads</h2>
            {node.projects.length === 0 ? (
              <p className="text-sm text-muted">No workloads assigned to this node.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {node.projects.map((p) => (
                  <li key={p.id}>
                    <button type="button" onClick={() => router.push(`/admin/workloads/${p.id}`)} className="hover:text-accent">
                      {p.name}
                    </button>
                    <span className="ml-2 text-xs text-muted">
                      {p.clientAccount.name} · {p._count.containers} containers
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {tab === "Workloads" && (
        <div className="rounded-lg border border-border bg-panel p-4">
          {node.projects.length === 0 ? (
            <p className="text-sm text-muted">No workloads assigned to this node.</p>
          ) : (
            <ul className="divide-y divide-border">
              {node.projects.map((p) => (
                <li key={p.id} className="flex items-center justify-between py-2.5">
                  <div>
                    <p className="font-medium">{p.name}</p>
                    <p className="text-xs text-muted">{p.clientAccount.name}</p>
                  </div>
                  <Button size="sm" variant="secondary" onClick={() => router.push(`/admin/workloads/${p.id}`)}>
                    Open
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {tab === "Containers" && (
        <DataTable
          columns={containerColumns}
          rows={containersQuery.data?.containers ?? []}
          searchableText={(c) => `${c.name} ${c.image}`}
          searchPlaceholder="Search containers…"
          loading={containersQuery.isLoading}
          emptyTitle="No containers on this node"
          onRowClick={(c) => router.push(`/admin/containers/${node.id}/${c.id}`)}
          rowKey={(c) => c.id}
        />
      )}

      {tab === "Activity" && (
        <div className="rounded-lg border border-border bg-panel">
          {activity.length === 0 ? (
            <p className="p-4 text-sm text-muted">No activity recorded for this node.</p>
          ) : (
            <ul className="divide-y divide-border">
              {activity.map((a) => (
                <li key={a.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                  <span>
                    {a.action.toLowerCase().replace(/_/g, " ")}
                    <span className="ml-2 text-xs text-muted">{a.actorEmail ?? "system"}</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted">{timeAgo(a.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`rounded-t px-4 py-2 text-sm ${tab === t ? "border-b-2 border-accent font-medium" : "text-muted hover:text-text"}`}
          >
            {t}
          </button>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-0.5">{value}</dd>
    </div>
  );
}
