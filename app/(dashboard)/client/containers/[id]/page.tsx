"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/lib/fetcher";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { LogViewer } from "@/components/logs/log-viewer";
import type { ContainerView, OperationView, OperationState } from "@/types/domain";
import { PageHeader } from "@/components/ui/page-header";
import { Breadcrumbs } from "@/components/navigation/breadcrumbs";

type DetailResponse = {
  container: ContainerView;
};

type ActionResponse = {
  operationId: string;
};

function OperationStateBadge({ state }: { state: OperationState }): React.JSX.Element {
  const variant =
    state === "SUCCEEDED" ? "success" : state === "FAILED" ? "danger" : state === "RUNNING" || state === "QUEUED" || state === "REQUESTED" ? "warning" : "default";
  return <Badge variant={variant}>{state}</Badge>;
}

export default function ContainerDetailPage(): React.JSX.Element {
  const params = useParams<{ id: string }>();
  const assignmentId = params.id;
  const queryClient = useQueryClient();
  const [activeOperationId, setActiveOperationId] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const detail = useQuery({
    queryKey: ["container", assignmentId],
    queryFn: () => apiFetch<DetailResponse>(`/api/client/containers/${assignmentId}`),
    refetchInterval: 7000
  });

  // Poll the active operation until it reaches a terminal state.
  const operationQuery = useQuery({
    queryKey: ["operation", activeOperationId],
    queryFn: () => apiFetch<{ operation: OperationView }>(`/api/client/operations/${activeOperationId}`),
    enabled: Boolean(activeOperationId),
    refetchInterval: 1500,
    refetchIntervalInBackground: false
  });

  const operation = operationQuery.data?.operation ?? null;

  useEffect(() => {
    if (!operation) {
      return;
    }
    if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(operation.state)) {
      setPollError(operation.state === "FAILED" ? operation.error ?? "Operation failed" : null);
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      setActiveOperationId(null);
      queryClient.invalidateQueries({ queryKey: ["container", assignmentId] });
      queryClient.invalidateQueries({ queryKey: ["client-containers"] });
      queryClient.invalidateQueries({ queryKey: ["client-operations"] });
      if (operation.state === "SUCCEEDED") {
        toast.success("Operation completed");
      }
    }
  }, [operation, assignmentId, queryClient]);

  useEffect(() => () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
    }
  }, []);

  const actionMutation = useMutation({
    mutationFn: async (action: "start" | "stop" | "restart") =>
      apiFetch<ActionResponse>(`/api/client/containers/${assignmentId}/action`, {
        method: "POST",
        body: JSON.stringify({ action })
      }),
    onSuccess: (data) => {
      toast.success("Action requested — waiting for agent…");
      setPollError(null);
      setActiveOperationId(data.operationId);
      queryClient.invalidateQueries({ queryKey: ["client-operations"] });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "Action failed";
      toast.error(message);
      setPollError(message);
    }
  });

  const container = detail.data?.container;
  const busy = Boolean(operation && !["SUCCEEDED", "FAILED", "CANCELLED"].includes(operation.state));
  const [confirmStop, setConfirmStop] = useState(false);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Container"
        title={container?.name ?? "Container details"}
        description="Live state, safe metadata, and recent logs."
        back={<Breadcrumbs items={[{ label: "Containers", href: "/client/containers" }, { label: container?.name ?? "Container" }]} />}
      />

      {detail.isLoading || !container ? (
        detail.isError ? (
          <Card className="panel">
            <CardContent className="p-6">
              <p className="text-sm text-critical-foreground">Failed to load container details.</p>
            </CardContent>
          </Card>
        ) : (
          <Card className="panel">
            <CardContent className="space-y-3 p-6">
              <div className="h-8 animate-pulse rounded bg-panelAlt" />
              <div className="h-8 animate-pulse rounded bg-panelAlt" />
              <div className="h-8 animate-pulse rounded bg-panelAlt" />
            </CardContent>
          </Card>
        )
      ) : (
        <>
          <Card className="panel">
            <CardHeader>
              <CardTitle>{container.name}</CardTitle>
              <CardDescription>{container.image}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-3">
                <StatusBadge status={container.status} />
                {!container.nodeOnline ? <Badge variant="danger">Node offline</Badge> : <Badge variant="success">Node online</Badge>}
              </div>

              {operation && (
                <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-panelAlt p-3">
                  <span className="text-sm">Operation {operation.type.replace("CONTAINER_", "").toLowerCase()}</span>
                  <OperationStateBadge state={operation.state} />
                  {operation.state === "FAILED" && (
                    <span className="text-sm text-critical-foreground">{operation.error ?? "Unknown failure"}</span>
                  )}
                </div>
              )}
              {pollError && !operation && <p className="text-sm text-critical-foreground">{pollError}</p>}

              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <Info label="Container ID" value={container.containerId} />
                <Info label="Node" value={container.nodeName} />
                <Info label="Uptime" value={container.uptime ?? "-"} />
                <Info label="Ports" value={container.ports} />
                <Info label="Restart count" value={container.restartCount?.toString() ?? "-"} />
                <Info label="CPU" value={container.cpuPercent !== null ? `${container.cpuPercent.toFixed(2)}%` : "-"} />
                <Info label="Memory" value={container.memoryUsage ?? "-"} />
                <Info label="Created" value={container.createdAt ?? "-"} />
                <Info label="Updated" value={container.lastUpdatedAt} />
              </div>
              <div className="flex flex-wrap gap-2">
                {!container.nodeOnline ? (
                  <p className="text-sm text-muted">Actions are disabled because the node is offline.</p>
                ) : busy ? (
                  <p className="text-sm text-warning-foreground">An operation is in progress — conflicting actions are disabled.</p>
                ) : container.status === "running" ? (
                  <>
                    <Button disabled={busy} variant="secondary" onClick={() => actionMutation.mutate("restart")}>
                      Restart
                    </Button>
                    <Button disabled={busy} variant="danger" onClick={() => setConfirmStop(true)}>
                      Stop
                    </Button>
                  </>
                ) : container.status === "stopped" ? (
                  <Button disabled={busy} onClick={() => actionMutation.mutate("start")}>
                    Start
                  </Button>
                ) : (
                  <p className="text-sm text-muted">No actions available while the container is {container.status}.</p>
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="panel">
            <CardHeader>
              <CardTitle>Logs</CardTitle>
              <CardDescription>Live log stream from this container.</CardDescription>
            </CardHeader>
            <CardContent>
              <LogViewer
                streamPath={`/api/client/containers/${assignmentId}/logs/stream`}
                historicalPath={`/api/client/containers/${assignmentId}/logs`}
                downloadName={container.name}
                containerStatus={container.status}
                nodeOnline={container.nodeOnline}
              />
            </CardContent>
          </Card>
        </>
      )}

      <ConfirmDialog
        open={confirmStop}
        onClose={() => setConfirmStop(false)}
        onConfirm={() => {
          setConfirmStop(false);
          actionMutation.mutate("stop");
        }}
        title={`Stop ${container?.name ?? "this container"}?`}
        impact="This will stop the container until it is started again."
        confirmLabel="Stop"
        danger
      />
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-panelAlt p-3">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 text-sm">{value}</p>
    </div>
  );
}
