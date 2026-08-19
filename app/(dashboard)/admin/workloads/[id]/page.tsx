"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/lib/fetcher";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DataTable, type Column } from "@/components/ui/data-table";
import { TabBar } from "@/components/ui/tab-bar";
import { WorkloadNetworksTab, WorkloadVolumesTab } from "@/components/workloads/networks-volumes-tabs";
import { timeAgo } from "@/lib/format";
import { humanizeAction } from "@/lib/format";

type WorkloadDetailPayload = {
  workload: {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    source: string;
    composeProject: string | null;
    node: { id: string; name: string; hostname: string; status: string };
    client: { id: string; name: string; slug: string } | null;
    grants: Array<{ id: string; allowedActions: string[]; clientName: string }>;
    containerSummaries: Array<{
      containerId: string;
      dockerName: string;
      status: string;
      cpuPercent: number | null;
      memoryUsage: string | null;
      restartCount: number | null;
      ports: string;
      uptime: string | null;
      health: string | null;
      inProject: boolean;
    }>;
    health: string;
    totalContainers: number;
    runningContainers: number;
    stoppedContainers: number;
    unhealthyContainers: number;
    restartingContainers: number;
    cpuPercent: number | null;
    memoryUsage: string | null;
    exposedPorts: string[];
  };
  activity: Array<{ id: string; action: string; actorEmail: string | null; result: string; createdAt: string }>;
};

type GrantModalState = { open: boolean; clientId: string; level: "start" | "view" };
type RestartResponse = { total: number; operationIds: string[]; failures: Array<{ dockerName: string; reason: string }> };

const TABS = ["Overview", "Containers", "Networks", "Volumes", "Activity"] as const;

export default function AdminWorkloadDetailPage(): React.JSX.Element {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<(typeof TABS)[number]>("Overview");
  const [grantModal, setGrantModal] = useState<GrantModalState>({ open: false, clientId: "", level: "start" });
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [confirmDetach, setConfirmDetach] = useState(false);
  const [confirmConvert, setConfirmConvert] = useState(false);

  const query = useQuery({
    queryKey: ["workload", params.id],
    queryFn: () => apiFetch<WorkloadDetailPayload>(`/api/admin/workloads/${params.id}`),
    refetchInterval: 15000
  });

  const restartMutation = useMutation({
    mutationFn: () => apiFetch<RestartResponse>(`/api/admin/workloads/${params.id}/restart`, { method: "POST" }),
    onSuccess: (data) => {
      if (data.failures.length === 0) {
        toast.success(`Restart requested for all ${data.total} containers`);
      } else if (data.failures.length < data.total) {
        toast.warning(`Restarted ${data.total - data.failures.length}/${data.total} — ${data.failures.length} failed to queue`);
      } else {
        toast.error("Failed to queue restart for any container");
      }
      queryClient.invalidateQueries({ queryKey: ["workload", params.id] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Restart failed")
  });

  const detachMutation = useMutation({
    mutationFn: () => apiFetch<{ id: string }>(`/api/admin/workloads/${params.id}/detach`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Detached from Compose tracking — workload is now MANUAL");
      queryClient.invalidateQueries({ queryKey: ["workload", params.id] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Detach failed")
  });

  const convertMutation = useMutation({
    mutationFn: () => apiFetch<{ id: string }>(`/api/admin/workloads/${params.id}/convert`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Converted to Compose-managed workload");
      queryClient.invalidateQueries({ queryKey: ["workload", params.id] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Conversion failed")
  });

  // Conversion eligibility (only meaningful for MANUAL workloads).
  const convertPreview = useQuery({
    queryKey: ["workload-convert-preview", params.id],
    queryFn: () =>
      apiFetch<{ preview: { eligible: boolean; composeProject?: string; workloadContainers?: string[]; allComposeServices?: string[]; reason?: string; detail?: string } }>(
        `/api/admin/workloads/${params.id}/convert-preview`
      ),
    enabled: true
  });

  if (query.isLoading) {
    return <div className="h-40 animate-pulse rounded-lg bg-panelAlt" />;
  }
  if (query.isError || !query.data) {
    return <p className="text-sm text-red-400">Failed to load workload.</p>;
  }

  const { workload, activity } = query.data;
  const healthVariant =
    workload.health === "healthy" ? "success" : workload.health === "degraded" ? "warning" : workload.health === "down" ? "danger" : "default";
  const failedOrRestarting = workload.containerSummaries.filter(
    (c) => c.inProject && (c.status === "restarting" || c.status === "unhealthy" || (c.restartCount ?? 0) >= 3)
  );

  const containerColumns: Column<(typeof workload.containerSummaries)[number]>[] = [
    {
      key: "name",
      header: "Container",
      render: (c) => (
        <div>
          <p className="font-medium">{c.dockerName}</p>
          <p className="text-xs text-muted">{c.containerId.slice(0, 12)}</p>
        </div>
      )
    },
    { key: "status", header: "Status", render: (c) => <Badge variant={c.status === "running" ? "success" : c.status === "stopped" ? "danger" : "warning"}>{c.status}</Badge> },
    { key: "cpu", header: "CPU", render: (c) => <span className="text-sm">{c.cpuPercent !== null ? `${c.cpuPercent}%` : "—"}</span>, hideBelow: "sm" },
    { key: "mem", header: "Memory", render: (c) => <span className="text-sm">{c.memoryUsage ?? "—"}</span>, hideBelow: "sm" },
    { key: "restarts", header: "Restarts", render: (c) => <span className="text-sm">{c.restartCount ?? 0}</span>, hideBelow: "md" },
    { key: "ports", header: "Ports", render: (c) => <span className="text-xs text-muted">{c.ports}</span>, hideBelow: "md" }
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <button
            type="button"
            onClick={() => router.push("/admin/workloads")}
            className="mb-1 text-sm text-accent hover:underline"
          >
            ← Workloads
          </button>
          <h1 className="text-3xl font-semibold">{workload.name}</h1>
          <p className="text-muted">
            {workload.description ?? workload.slug} · {workload.node.name}
            {workload.source === "COMPOSE" && (
              <span className="ml-2 text-xs">
                <Badge variant="default">Compose{workload.composeProject ? `: ${workload.composeProject}` : ""}</Badge>
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={healthVariant}>{workload.health}</Badge>
          <Button size="sm" variant="secondary" onClick={() => router.push(`/admin/activity?projectId=${workload.id}`)}>
            View activity
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setGrantModal({ open: true, clientId: "", level: "start" })}>
            Grant access
          </Button>
          {workload.source === "MANUAL" && convertPreview.data?.preview.eligible && (
            <Button size="sm" variant="secondary" onClick={() => setConfirmConvert(true)}>
              Convert to Compose-managed
            </Button>
          )}
          {workload.source === "COMPOSE" && (
            <Button size="sm" variant="secondary" onClick={() => setConfirmDetach(true)}>
              Detach from Compose
            </Button>
          )}
          {workload.totalContainers > 0 && (
            <Button size="sm" variant="danger" onClick={() => setConfirmRestart(true)} disabled={restartMutation.isPending}>
              Restart workload
            </Button>
          )}
        </div>
      </div>

      {failedOrRestarting.length > 0 && (
        <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm text-amber-300">
          {failedOrRestarting.length} container{failedOrRestarting.length > 1 ? "s" : ""} recently failed or is restarting:{" "}
          {failedOrRestarting.map((c) => c.dockerName).join(", ")}
        </div>
      )}

      {/* Overview */}
      {tab === "Overview" && (
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="rounded-lg border border-border bg-panel p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">Status</h2>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <Stat label="Node" value={workload.node.name} />
              <Stat label="Hostname" value={workload.node.hostname} />
              <Stat label="Node state" value={workload.node.status} />
              <Stat label="Containers" value={`${workload.runningContainers}/${workload.totalContainers} running`} />
              <Stat label="CPU" value={workload.cpuPercent !== null ? `${workload.cpuPercent}%` : "—"} />
              <Stat label="Memory" value={workload.memoryUsage ?? "—"} />
              <Stat label="Client" value={workload.client?.name ?? "—"} />
              <Stat label="Stopped" value={String(workload.stoppedContainers)} />
              <Stat label="Unhealthy" value={String(workload.unhealthyContainers)} />
            </dl>
            {workload.exposedPorts.length > 0 && (
              <div className="mt-4">
                <p className="mb-1 text-xs uppercase tracking-wide text-muted">Exposed ports</p>
                <div className="flex flex-wrap gap-1">
                  {workload.exposedPorts.map((p) => (
                    <Badge key={p}>{p}</Badge>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="rounded-lg border border-border bg-panel p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">Access</h2>
            {workload.grants.length === 0 ? (
              <p className="text-sm text-muted">No client has access to this workload yet.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {workload.grants.map((g) => (
                  <li key={g.id} className="flex items-center justify-between rounded border border-border bg-panelAlt px-3 py-2">
                    <span>{g.clientName}</span>
                    <span className="text-xs text-muted">{g.allowedActions.join(", ")}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* Containers */}
      {tab === "Containers" && (
        <DataTable
          columns={containerColumns}
          rows={workload.containerSummaries}
          searchableText={(c) => c.dockerName}
          searchPlaceholder="Search containers…"
          emptyTitle="No containers in this workload"
          emptyBody="Attach containers to this stack from the container detail page or the grants workflow."
          onRowClick={(c) => router.push(`/admin/containers/${workload.node.id}/${c.containerId}`)}
        />
      )}

      {/* Networks */}
      {tab === "Networks" && <WorkloadNetworksTab resourcesUrl={`/api/admin/workloads/${workload.id}/resources`} />}

      {/* Volumes */}
      {tab === "Volumes" && <WorkloadVolumesTab resourcesUrl={`/api/admin/workloads/${workload.id}/resources`} />}

      {/* Activity */}
      {tab === "Activity" && (
        <div className="rounded-lg border border-border bg-panel">
          {activity.length === 0 ? (
            <p className="p-4 text-sm text-muted">No activity recorded for this workload.</p>
          ) : (
            <ul className="divide-y divide-border">
              {activity.map((a) => (
                <li key={a.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                  <span>
                    {humanizeAction(a.action)}
                    <span className="ml-2 text-xs text-muted">{a.actorEmail ?? "system"}</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted">{timeAgo(a.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Tab bar */}
      <TabBar tabs={TABS} active={tab} onChange={setTab} idPrefix="workload" />

      <GrantModal
        open={grantModal.open}
        onClose={() => setGrantModal({ open: false, clientId: "", level: "start" })}
        workloadId={workload.id}
        workloadName={workload.name}
        clientId={grantModal.clientId}
        level={grantModal.level}
        onClientChange={(v) => setGrantModal((m) => ({ ...m, clientId: v }))}
        onLevelChange={(v) => setGrantModal((m) => ({ ...m, level: v }))}
      />

      <ConfirmDialog
        open={confirmRestart}
        onClose={() => setConfirmRestart(false)}
        onConfirm={() => {
          setConfirmRestart(false);
          restartMutation.mutate();
        }}
        title={`Restart ${workload.name}?`}
        impact={`${workload.totalContainers} container${workload.totalContainers === 1 ? "" : "s"} will be restarted and the service may be temporarily unavailable.`}
        confirmLabel={`Restart ${workload.totalContainers} container${workload.totalContainers === 1 ? "" : "s"}`}
        danger
      />

      <ConfirmDialog
        open={confirmDetach}
        onClose={() => setConfirmDetach(false)}
        onConfirm={() => {
          setConfirmDetach(false);
          detachMutation.mutate();
        }}
        title={`Detach ${workload.name} from Compose?`}
        impact="HostPanel will stop automatically tracking this Compose project and treat the workload as MANUAL. This does NOT stop or delete any containers, volumes, networks, or Docker Compose resources — those are left completely untouched."
        confirmLabel="Detach from Compose"
      />

      <ConfirmDialog
        open={confirmConvert}
        onClose={() => setConfirmConvert(false)}
        onConfirm={() => {
          setConfirmConvert(false);
          convertMutation.mutate();
        }}
        title={`Convert ${workload.name} to Compose-managed?`}
        impact={`HostPanel will start tracking this workload from Compose project "${convertPreview.data?.preview.composeProject ?? ""}". Its ID, name, client, grants and activity history are retained. Membership will then sync automatically as containers are recreated.`}
        confirmLabel="Convert to Compose-managed"
      />
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

function GrantModal({
  open,
  onClose,
  workloadId,
  workloadName,
  clientId,
  level,
  onClientChange,
  onLevelChange
}: {
  open: boolean;
  onClose: () => void;
  workloadId: string;
  workloadName: string;
  clientId: string;
  level: "start" | "view";
  onClientChange: (v: string) => void;
  onLevelChange: (v: "start" | "view") => void;
}): React.JSX.Element {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clientsQuery = useQuery({
    queryKey: ["admin-clients-refs"],
    queryFn: () => apiFetch<{ clients: Array<{ id: string; name: string }> }>("/api/admin/clients-refs"),
    enabled: open
  });

  async function save(): Promise<void> {
    if (!clientId) return;
    setSaving(true);
    setError(null);
    try {
      await apiFetch<{ id: string }>("/api/admin/grants", {
        method: "POST",
        body: JSON.stringify({
          clientAccountId: clientId,
          projectId: workloadId,
          allowedActions: level === "start" ? ["start", "stop", "restart", "view_logs"] : ["view_logs"]
        })
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Grant failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Grant access"
      description={`Choose which client may access ${workloadName}.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving || !clientId}>
            {saving ? "Saving…" : "Grant access"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-1">
          <label htmlFor="grant-client" className="text-sm text-muted">
            Client
          </label>
          <select
            id="grant-client"
            value={clientId}
            onChange={(e) => onClientChange(e.target.value)}
            className="w-full rounded-md border border-border bg-panelAlt px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-accent"
          >
            <option value="">Select client…</option>
            {(clientsQuery.data?.clients ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-sm text-muted">Permission level</label>
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="grant-level"
                checked={level === "start"}
                onChange={() => onLevelChange("start")}
                className="accent-accent"
              />
              Operate — start, stop, restart and view logs
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="grant-level"
                checked={level === "view"}
                onChange={() => onLevelChange("view")}
                className="accent-accent"
              />
              View only — read status and logs
            </label>
          </div>
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>
    </Modal>
  );
}
