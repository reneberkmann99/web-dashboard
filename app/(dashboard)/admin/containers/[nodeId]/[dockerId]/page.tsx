"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { apiFetch } from "@/lib/fetcher";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { LogViewer } from "@/components/logs/log-viewer";
import { shortId, timeAgo } from "@/lib/format";
import type { ContainerView, OperationView, OperationState } from "@/types/domain";

type DetailResponse = { container: ContainerView; nodeOnline: boolean };
type ActionResponse = { operationId: string };

function OperationStateBadge({ state }: { state: OperationState }): React.JSX.Element {
  const variant =
    state === "SUCCEEDED"
      ? "success"
      : state === "FAILED"
        ? "danger"
        : state === "RUNNING" || state === "QUEUED" || state === "REQUESTED"
          ? "warning"
          : "default";
  return <Badge variant={variant}>{state}</Badge>;
}

export default function DirectContainerDetailPage(): React.JSX.Element {
  const params = useParams<{ nodeId: string; dockerId: string }>();
  const { nodeId, dockerId } = params;
  const router = useRouter();
  const queryClient = useQueryClient();

  const [activeOperationId, setActiveOperationId] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<"start" | "stop" | "restart" | null>(null);
  const [copied, setCopied] = useState(false);

  const detail = useQuery({
    queryKey: ["direct-container", nodeId, dockerId],
    queryFn: () => apiFetch<DetailResponse>(`/api/admin/containers/direct/${nodeId}/${dockerId}`),
    refetchInterval: 8000
  });

  const operationQuery = useQuery({
    queryKey: ["admin-operation", activeOperationId],
    queryFn: () => apiFetch<{ operation: OperationView }>(`/api/admin/operations/${activeOperationId}`),
    enabled: Boolean(activeOperationId),
    refetchInterval: 1500
  });
  const operation = operationQuery.data?.operation ?? null;

  useEffect(() => {
    if (!operation) return;
    if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(operation.state)) {
      setActiveOperationId(null);
      queryClient.invalidateQueries({ queryKey: ["direct-container", nodeId, dockerId] });
      if (operation.state === "SUCCEEDED") toast.success("Operation completed");
      if (operation.state === "FAILED") toast.error(operation.error ?? "Operation failed");
    }
  }, [operation, nodeId, dockerId, queryClient]);

  const actionMutation = useMutation({
    mutationFn: async (action: "start" | "stop" | "restart") =>
      apiFetch<ActionResponse>(`/api/admin/containers/direct/${nodeId}/${dockerId}`, {
        method: "POST",
        body: JSON.stringify({ action })
      }),
    onSuccess: (data) => {
      toast.success("Action requested");
      setActiveOperationId(data.operationId);
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Action failed")
  });

  const container = detail.data?.container;
  const busy = Boolean(operation && !["SUCCEEDED", "FAILED", "CANCELLED"].includes(operation.state));
  const nodeOnline = detail.data?.nodeOnline ?? false;

  const copyId = async (text: string): Promise<void> => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (detail.isLoading) {
    return <div className="h-40 animate-pulse rounded-lg bg-panelAlt" />;
  }
  if (detail.isError || !container) {
    return (
      <div className="rounded-lg border border-danger/30 bg-danger/5 p-8 text-center">
        <p className="text-sm text-red-300">Failed to load container.</p>
        <p className="mt-1 text-xs text-muted">
          {detail.error instanceof Error ? detail.error.message : "The container may no longer exist on this node."}
        </p>
        <Button className="mt-4" variant="secondary" onClick={() => router.back()}>
          Go back
        </Button>
      </div>
    );
  }

  const actions: Array<{ action: "start" | "stop" | "restart"; label: string; danger?: boolean; impact: string }> =
    container.status === "running"
      ? [
          { action: "restart", label: "Restart", impact: "This will briefly interrupt the service." },
          {
            action: "stop",
            label: "Stop",
            danger: true,
            impact: "This will stop the container until it is started again."
          }
        ]
      : container.status === "stopped"
        ? [{ action: "start", label: "Start", impact: "This will start the container." }]
        : [];

  return (
    <div className="space-y-6">
      <button type="button" onClick={() => router.back()} className="text-sm text-accent hover:underline">
        ← Back
      </button>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold">{container.name}</h1>
          <p className="text-muted">{container.image}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge
            variant={
              container.status === "running" ? "success" : container.status === "stopped" ? "danger" : "warning"
            }
          >
            {container.status}
          </Badge>
          {!nodeOnline && <Badge variant="danger">Node unreachable</Badge>}
        </div>
      </div>

      {operation && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-panelAlt p-3">
          <span className="text-sm">{operation.type.replace("CONTAINER_", "").toLowerCase()}</span>
          <OperationStateBadge state={operation.state} />
          {operation.state === "FAILED" && (
            <span className="text-sm text-red-400">{operation.error ?? "Unknown failure"}</span>
          )}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          <section className="rounded-lg border border-border bg-panel p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">Details</h2>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <Stat label="Container ID">
                <button
                  type="button"
                  onClick={() => void copyId(container.containerId)}
                  className="inline-flex items-center gap-1 text-accent hover:underline"
                  aria-label="Copy container id"
                >
                  {shortId(container.containerId)} <Copy size={12} />
                </button>
                {copied && <span className="ml-1 text-xs text-muted">copied</span>}
              </Stat>
              <Stat label="Node" value={container.nodeName} />
              <Stat label="Uptime" value={container.uptime ?? "—"} />
              <Stat label="Restart count" value={String(container.restartCount ?? 0)} />
              <Stat
                label="CPU"
                value={container.cpuPercent !== null ? `${container.cpuPercent.toFixed(1)}%` : "—"}
              />
              <Stat label="Memory" value={container.memoryUsage ?? "—"} />
              <Stat label="Restart policy" value={container.details?.restartPolicy ?? "—"} />
              <Stat label="Health" value={container.details?.health ?? "—"} />
              <Stat label="Created" value={timeAgo(container.createdAt)} />
              <Stat label="Stack" value={container.projectName ?? "—"} />
              <Stat label="Client" value={container.clientName} />
              <Stat label="Ports" value={container.ports} />
            </dl>
          </section>

          <section className="rounded-lg border border-border bg-panel p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">Actions</h2>
            {!nodeOnline ? (
              <p className="text-sm text-muted">
                Actions are disabled because node <strong>{container.nodeName}</strong> is not responding.
              </p>
            ) : busy ? (
              <p className="text-sm text-amber-300">
                An operation is in progress — conflicting actions are disabled.
              </p>
            ) : actions.length === 0 ? (
              <p className="text-sm text-muted">
                No actions available while the container is {container.status}.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {actions.map((a) => (
                  <Button
                    key={a.action}
                    variant={a.danger ? "danger" : "default"}
                    onClick={() => setConfirmAction(a.action)}
                  >
                    {a.label}
                  </Button>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-lg border border-border bg-panel p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">Networks</h2>
            {(container.details?.networks?.length ?? 0) === 0 ? (
              <p className="text-sm text-muted">No networks reported.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {container.details?.networks?.map((n) => (
                  <li key={n.name} className="flex justify-between">
                    <span>{n.name}</span>
                    <span className="text-muted">{n.ipAddress || "—"}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-lg border border-border bg-panel p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">Volumes &amp; mounts</h2>
            {(container.details?.mounts?.length ?? 0) === 0 ? (
              <p className="text-sm text-muted">No mounts reported.</p>
            ) : (
              <ul className="space-y-1 text-xs">
                {container.details?.mounts?.map((m, i) => (
                  <li key={i} className="text-muted">
                    <span className="text-text">{m.destination}</span> ← {m.source || "(anonymous)"}{" "}
                    <span className="text-muted/60">({m.type})</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {container.details?.labels && Object.keys(container.details.labels).length > 0 && (
            <section className="rounded-lg border border-border bg-panel p-4">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">Labels</h2>
              <div className="flex flex-wrap gap-1">
                {Object.entries(container.details.labels)
                  .slice(0, 12)
                  .map(([k, v]) => (
                    <Badge key={k}>
                      {k}={v.length > 40 ? `${v.slice(0, 40)}…` : v}
                    </Badge>
                  ))}
              </div>
            </section>
          )}
        </div>

        <section className="rounded-lg border border-border bg-panel p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Logs</h2>
          </div>
          <LogViewer
            streamUrl={(tail) =>
              `/api/admin/containers/direct/${nodeId}/${dockerId}/logs/stream?tail=${tail}`
            }
            downloadName={container.name}
          />
        </section>
      </div>

      <ConfirmDialog
        open={confirmAction !== null}
        onClose={() => setConfirmAction(null)}
        onConfirm={() => {
          if (confirmAction) actionMutation.mutate(confirmAction);
        }}
        title={
          confirmAction
            ? `${confirmAction.charAt(0).toUpperCase() + confirmAction.slice(1)} ${container.name}?`
            : ""
        }
        impact={
          actions.find((a) => a.action === confirmAction)?.impact ??
          "This will change the container's runtime state."
        }
        confirmLabel={confirmAction ? confirmAction.charAt(0).toUpperCase() + confirmAction.slice(1) : "Confirm"}
        danger={confirmAction === "stop"}
      />
    </div>
  );
}

function Stat({
  label,
  value,
  children
}: {
  label: string;
  value?: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-0.5 break-words">{children ?? value ?? "—"}</dd>
    </div>
  );
}
