"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/lib/fetcher";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AttentionBadge } from "@/components/ui/attention-badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { TabBar } from "@/components/ui/tab-bar";
import { PageHeader } from "@/components/ui/page-header";
import { StatePanel, LoadingBlock } from "@/components/ui/state-panel";
import { CodePanel } from "@/components/ui/code-panel";
import { formatBytes, formatDateTime, timeAgo } from "@/lib/format";
import type { RuntimeContainer } from "@/server/services/node-agent/types";
import type { AttentionItem, AttentionSeverity } from "@/types/domain";
import { ContextBackLink } from "@/components/navigation/context-back-link";
import { rememberResourceNavigation, useDetailTab } from "@/components/navigation/view-state";
import { ActivityTimeline } from "@/components/activity/activity-timeline";

type NodeDetailPayload = {
  node: {
    id: string;
    name: string;
    hostname: string;
    apiBaseUrl: string;
    dockerContext: string | null;
    status: string;
    heartbeatState: "ONLINE" | "STALE" | "OFFLINE";
    telemetryCurrent: boolean;
    isActive: boolean;
    lastHeartbeatAt: string | null;
    agentVersion: string | null;
    dockerVersion: string | null;
    createdAt: string;
    osInfo: Record<string, unknown> | null;
    systemInfo: Record<string, unknown> | null;
    containerCount: number;
    runningCount: number;
    unhealthyCount: number;
    stoppedCount: number;
    storageSummary: Array<{ type: string; totalCount: number; active: number; size: string; reclaimable: string }>;
    attention: AttentionSeverity | "healthy" | "unknown";
    projects: Array<{ id: string; name: string; slug: string; clientAccount: { name: string } | null; _count: { containers: number } }>;
  };
  attentionItems: AttentionItem[];
  maintenance: Array<{ id: string; startsAt: string; endsAt: string; reason: string | null; notificationBehavior: "SUPPRESS" | "KEEP" }>;
  activity: Array<{ id: string; action: string; actorEmail: string | null; result: string; createdAt: string }>;
};

type ContainersPayload = { containers: RuntimeContainer[] };
type EnrollTokenPayload = { token: string; expiresAt: string; ttlMinutes: number };

const TABS = ["Overview", "Workloads", "Containers", "Configuration", "Activity"] as const;

export default function AdminNodeDetailPage(): React.JSX.Element {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [tab, setTab] = useDetailTab(TABS, "Overview");

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

  const [enrollToken, setEnrollToken] = useState<string | null>(null);
  const enrollMutation = useMutation({
    mutationFn: () =>
      apiFetch<EnrollTokenPayload>("/api/admin/nodes/enroll-token", {
        method: "POST",
        body: JSON.stringify({ nodeId: params.id })
      }),
    onSuccess: (data) => {
      setEnrollToken(data.token);
      void navigator.clipboard.writeText(data.token);
      toast.success("Re-enrollment token generated and copied (15 min, single-use)");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Failed to generate token")
  });

  if (detail.isLoading) return <LoadingBlock />;
  if (detail.isError || !detail.data) return <StatePanel tone="error" title="Failed to load node" />;

  const { node, activity, attentionItems, maintenance } = detail.data;
  const offline = node.heartbeatState === "OFFLINE";
  const stale = node.heartbeatState === "STALE";

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
      <PageHeader
          eyebrow="Node"
          title={node.name}
          back={<ContextBackLink fallback="/admin/nodes" label="Nodes" allowedReturnPrefixes={["/admin/nodes"]} />}
          description={<div className="flex flex-wrap items-center gap-2"><span className="font-mono text-sm">{node.hostname}</span><Badge variant={offline ? "danger" : stale ? "warning" : "success"}>{offline ? "offline" : stale ? "stale heartbeat" : "online"}</Badge>{node.attention !== "healthy" && <AttentionBadge severity={node.attention} />}{!node.isActive && <Badge>disabled</Badge>}</div>}
          actions={<Button variant="outline" size="sm" onClick={() => router.push(`/admin/activity?nodeId=${params.id}`)}>View activity →</Button>}
      />

      {/* Tab bar — directly after the page header; status content follows it. */}
      <TabBar tabs={TABS} active={tab} onChange={setTab} idPrefix="node" />

      {offline && (
          <p className="mt-2 rounded-lg border border-critical/30 bg-critical/5 p-3 text-sm text-critical-foreground">
            This node is not responding. Last heartbeat: {timeAgo(node.lastHeartbeatAt)}. Check the Noderaft Agent container or
            host connectivity.
          </p>
      )}
      {maintenance[0] && (
          <p className="mt-2 rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm text-warning-foreground">
            MAINTENANCE until {formatDateTime(maintenance[0].endsAt)}{maintenance[0].reason ? ` — ${maintenance[0].reason}` : ""}. Underlying node state remains {node.status.toLowerCase()}.
          </p>
      )}

      {tab === "Overview" && (
        <div className="space-y-6">
          {attentionItems.length > 0 && (
            <div className="space-y-2">
              {attentionItems.map((item) => (
                <div
                  key={item.id}
                  className={`flex items-start justify-between gap-3 rounded-lg border p-3 ${
                    item.severity === "critical" ? "border-danger/30 bg-danger/5" : "border-warning/30 bg-warning/5"
                  }`}
                >
                  <div>
                    <p className="text-sm font-medium">{item.title}</p>
                    <p className="text-xs text-muted">{item.detail}</p>
                    {item.acknowledgement && <p className="mt-1 text-xs text-info-foreground">Acknowledged by {item.acknowledgement.acknowledgedBy}</p>}
                    {item.silence && <p className="text-xs text-muted">Notifications silenced until {formatDateTime(item.silence.endsAt)}</p>}
                  </div>
                  <div className="flex items-center gap-2"><AttentionBadge severity={item.severity} /><Button size="sm" variant="ghost" onClick={() => router.push(`/admin/attention?conditionId=${item.id}`)}>View issue</Button></div>
                </div>
              ))}
            </div>
          )}
          <div className="grid gap-6 lg:grid-cols-2">
          <div className="rounded-lg border border-border bg-panel p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">Host</h2>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <Stat label="State" value={node.status.toLowerCase()} />
              <Stat label="Last heartbeat" value={timeAgo(node.lastHeartbeatAt)} />
              <Stat label="Noderaft Agent version" value={node.agentVersion ?? "—"} />
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
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">Resource usage</h2>
            {(() => {
              if (!node.telemetryCurrent) {
                return <p className="text-sm text-muted">Telemetry unavailable. Last reported {timeAgo(node.lastHeartbeatAt)}.</p>;
              }
              const sys = node.systemInfo ?? {};
              const cpu = typeof sys.cpuPercent === "number" ? sys.cpuPercent : null;
              const mem = typeof sys.memPercent === "number" ? sys.memPercent : null;
              const disk = typeof sys.diskPercent === "number" ? sys.diskPercent : null;
              if (cpu === null && mem === null && disk === null) {
                return <p className="text-sm text-muted">Resource metrics unavailable from this agent yet.</p>;
              }
              return (
                <dl className="grid grid-cols-3 gap-3 text-sm">
                  <Stat label="CPU" value={cpu !== null ? `${cpu.toFixed(0)}%` : "—"} />
                  <Stat label="Memory" value={mem !== null ? `${mem.toFixed(0)}%` : "—"} />
                  <Stat label="Disk" value={disk !== null ? `${disk.toFixed(0)}%` : "—"} />
                </dl>
              );
            })()}
          </div>

          <div className="rounded-lg border border-border bg-panel p-4 lg:col-span-2">
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
                      {p.clientAccount?.name ?? "No client"} · {p._count.containers} containers
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          </div>
        </div>
      )}

      {tab === "Workloads" && (
        <DataTable
          columns={[
            { key: "name", header: "Workload", sortValue: (p: (typeof node.projects)[number]) => p.name, render: (p) => <p className="font-medium">{p.name}</p> },
            { key: "client", header: "Client", render: (p: (typeof node.projects)[number]) => <span>{p.clientAccount?.name ?? "No client"}</span> },
            { key: "containers", header: "Containers", sortValue: (p: (typeof node.projects)[number]) => p._count.containers, render: (p) => <span className="font-mono">{p._count.containers}</span> }
          ]}
          rows={node.projects}
          searchableText={(p) => `${p.name} ${p.clientAccount?.name ?? ""}`}
          searchPlaceholder="Search workloads…"
          stateKey={`node:${node.id}:workloads`}
          ariaLabel="Node workloads"
          emptyTitle="No workloads assigned"
          emptyBody="Workloads assigned to this node will appear here."
          rowKey={(p) => p.id}
          onRowClick={(p) => {
            const href = `/admin/workloads/${p.id}`;
            rememberResourceNavigation(href);
            router.push(href);
          }}
        />
      )}

      {tab === "Containers" && (
        <DataTable
          columns={containerColumns}
          rows={containersQuery.data?.containers ?? []}
          searchableText={(c) => `${c.name} ${c.image}`}
          searchPlaceholder="Search containers…"
          loading={containersQuery.isLoading}
          emptyTitle="No containers on this node"
          stateKey={`node:${node.id}:containers`}
          ariaLabel="Node containers"
          onRowClick={(c) => {
            const href = `/admin/containers/${node.id}/${c.id}`;
            rememberResourceNavigation(href);
            router.push(href);
          }}
          rowKey={(c) => c.id}
        />
      )}

      {tab === "Configuration" && (
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="rounded-lg border border-border bg-panel p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">Noderaft Agent configuration</h2>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <Stat label="Node ID" value={node.id} />
              <Stat label="Display name" value={node.name} />
              <Stat label="Hostname" value={node.hostname} />
              <Stat label="Noderaft Agent endpoint" value={node.apiBaseUrl} />
              <Stat label="Docker context" value={node.dockerContext ?? "default"} />
              <Stat label="Noderaft Agent version" value={node.agentVersion ?? "—"} />
              <Stat label="Enabled" value={node.isActive ? "yes" : "no"} />
              <Stat label="Enrollment mode" value={node.agentVersion ? "token (self-registered)" : "manual"} />
              <Stat label="Registered" value={formatDateTime(node.createdAt)} />
            </dl>
          </div>

          <div className="rounded-lg border border-border bg-panel p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">Polling & reconciliation</h2>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <Stat label="Noderaft Agent list cache" value="15 s" />
              <Stat label="Compose reconcile" value="every 30 s (throttled)" />
              <Stat label="Dashboard poll" value="8–20 s" />
              <Stat label="Heartbeat" value="on inventory refresh" />
            </dl>
          </div>

          <div className="rounded-lg border border-border bg-panel p-4 lg:col-span-2">
            <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted">Noderaft Agent credential rotation</h2>
            <p className="mb-3 text-sm text-muted">
              Generate a one-time re-enrollment token (15 min TTL). Noderaft Agent rotates its API key the next time it
              starts with <code className="rounded bg-panelAlt px-1">AGENT_ENROLL_TOKEN</code> set; the old key stops
              working immediately after re-enrollment.
            </p>
            <Button size="sm" variant="secondary" onClick={() => enrollMutation.mutate()} disabled={enrollMutation.isPending}>
              {enrollMutation.isPending ? "Generating…" : "Generate re-enrollment token"}
            </Button>
            {enrollToken && (
              <CodePanel className="mt-3" label="One-time enrollment token"><span className="break-all">{enrollToken}</span></CodePanel>
            )}
          </div>
        </div>
      )}

      {tab === "Activity" && (
        <div className="rounded-lg border border-border bg-panel">
          <ActivityTimeline events={activity} resourceName={node.name} emptyText="No activity recorded for this node." />
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-0.5 break-words font-mono text-sm">{value}</dd>
    </div>
  );
}
