"use client";

import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/lib/fetcher";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";
import type { ContainerView } from "@/types/domain";

type DetailResponse = {
  container: ContainerView;
};

type LogsResponse = {
  logs: string[];
  nodeOnline: boolean;
};

export default function ContainerDetailPage(): React.JSX.Element {
  const params = useParams<{ id: string }>();
  const assignmentId = params.id;
  const queryClient = useQueryClient();

  const detail = useQuery({
    queryKey: ["container", assignmentId],
    queryFn: () => apiFetch<DetailResponse>(`/api/client/containers/${assignmentId}`),
    refetchInterval: 7000
  });

  const logs = useQuery({
    queryKey: ["container-logs", assignmentId],
    queryFn: () => apiFetch<LogsResponse>(`/api/client/containers/${assignmentId}/logs`),
    refetchInterval: 12000
  });

  const actionMutation = useMutation({
    mutationFn: async (action: "start" | "stop" | "restart") =>
      apiFetch<{ success: boolean }>(`/api/client/containers/${assignmentId}/action`, {
        method: "POST",
        body: JSON.stringify({ action })
      }),
    onSuccess: () => {
      toast.success("Action submitted");
      queryClient.invalidateQueries({ queryKey: ["container", assignmentId] });
      queryClient.invalidateQueries({ queryKey: ["client-containers"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Action failed");
    }
  });

  const container = detail.data?.container;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Container details</h1>
        <p className="text-muted">Live state, safe metadata, and recent logs.</p>
      </div>

      {detail.isLoading || !container ? (
        <Card className="panel">
          <CardContent className="space-y-3 p-6">
            <div className="h-8 animate-pulse rounded bg-panelAlt" />
            <div className="h-8 animate-pulse rounded bg-panelAlt" />
            <div className="h-8 animate-pulse rounded bg-panelAlt" />
          </CardContent>
        </Card>
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
              <div className="flex gap-2">
                <Button disabled={actionMutation.isPending} onClick={() => actionMutation.mutate("start")}>
                  Start
                </Button>
                <Button disabled={actionMutation.isPending} variant="secondary" onClick={() => actionMutation.mutate("restart")}>
                  Restart
                </Button>
                <Button
                  disabled={actionMutation.isPending}
                  variant="danger"
                  onClick={() => {
                    if (window.confirm("Stop this container?")) {
                      actionMutation.mutate("stop");
                    }
                  }}
                >
                  Stop
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card className="panel">
            <CardHeader>
              <CardTitle>Recent logs</CardTitle>
              <CardDescription>Last log lines from this container.</CardDescription>
            </CardHeader>
            <CardContent>
              {logs.isLoading ? (
                <div className="space-y-3">
                  <div className="h-8 animate-pulse rounded bg-panelAlt" />
                  <div className="h-8 animate-pulse rounded bg-panelAlt" />
                </div>
              ) : (
                <pre className="max-h-[460px] overflow-auto rounded-lg border border-border bg-black/40 p-4 text-xs text-slate-200">
                  {(logs.data?.logs ?? ["No logs available"]).join("\n")}
                </pre>
              )}
            </CardContent>
          </Card>
        </>
      )}
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
