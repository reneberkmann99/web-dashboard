"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/lib/fetcher";
import type { ContainerView } from "@/types/domain";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/status-badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PageHeader } from "@/components/ui/page-header";

type ListResponse = {
  containers: ContainerView[];
};

export default function ClientContainersPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [confirmStop, setConfirmStop] = useState<{ assignmentId: string; name: string } | null>(null);

  const query = useQuery({
    queryKey: ["client-containers"],
    queryFn: () => apiFetch<ListResponse>("/api/client/containers"),
    refetchInterval: 7000
  });

  const actionMutation = useMutation({
    mutationFn: async (input: { assignmentId: string; action: "start" | "stop" | "restart" }) =>
      apiFetch<{ success: boolean }>(`/api/client/containers/${input.assignmentId}/action`, {
        method: "POST",
        body: JSON.stringify({ action: input.action })
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["client-containers"] });
      toast.success("Action submitted");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Action failed");
    }
  });

  const filtered = useMemo(() => {
    const items = query.data?.containers ?? [];
    const normalized = search.trim().toLowerCase();
    if (!normalized) {
      return items;
    }

    return items.filter((item) => {
      return (
        item.name.toLowerCase().includes(normalized) ||
        item.image.toLowerCase().includes(normalized) ||
        item.nodeName.toLowerCase().includes(normalized)
      );
    });
  }, [query.data?.containers, search]);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Runtime inventory"
        title="Containers"
        description="Status, resource metrics, and controls for your assigned services."
        actions={<Input
          className="w-full max-w-xs"
          placeholder="Search containers"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />}
      />

      <Card className="panel">
        <CardHeader>
          <CardTitle>Assigned containers</CardTitle>
          <CardDescription>Polled every 7 seconds.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {query.isLoading ? (
            <div className="space-y-3">
              <div className="h-10 animate-pulse rounded bg-panelAlt" />
              <div className="h-10 animate-pulse rounded bg-panelAlt" />
              <div className="h-10 animate-pulse rounded bg-panelAlt" />
            </div>
          ) : query.isError ? (
            <p className="text-sm text-critical-foreground">Failed to load containers.</p>
          ) : !filtered.length ? (
            <p className="text-sm text-muted">{search ? "No containers match your search." : "No containers assigned yet."}</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="pb-3">Name</th>
                  <th className="pb-3">Status</th>
                  <th className="pb-3">Uptime</th>
                  <th className="pb-3">CPU</th>
                  <th className="pb-3">Memory</th>
                  <th className="pb-3">Ports</th>
                  <th className="pb-3">Node</th>
                  <th className="pb-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((container) => (
                  <tr className="border-t border-border" key={container.assignmentId}>
                    <td className="py-3">
                      <Link className="font-medium text-accent hover:underline" href={`/client/containers/${container.assignmentId}`}>
                        {container.name}
                      </Link>
                      <p className="text-xs text-muted">{container.image}</p>
                    </td>
                    <td className="py-3">
                      <div className="flex items-center gap-2">
                        <StatusBadge status={container.status} />
                        {!container.nodeOnline ? <Badge variant="danger">Node offline</Badge> : null}
                      </div>
                    </td>
                    <td className="py-3">{container.uptime ?? "-"}</td>
                    <td className="py-3">{container.cpuPercent !== null ? `${container.cpuPercent.toFixed(2)}%` : "-"}</td>
                    <td className="py-3">{container.memoryUsage ?? "-"}</td>
                    <td className="py-3">{container.ports}</td>
                    <td className="py-3">{container.nodeName}</td>
                    <td className="py-3">
                      <div className="flex gap-2">
                        <ActionButton
                          action="start"
                          assignmentId={container.assignmentId}
                          allowed={container.allowedActions.includes("start")}
                          loading={actionMutation.isPending}
                          onClick={(input) => actionMutation.mutate(input)}
                        />
                        <ActionButton
                          action="restart"
                          assignmentId={container.assignmentId}
                          allowed={container.allowedActions.includes("restart")}
                          loading={actionMutation.isPending}
                          onClick={(input) => actionMutation.mutate(input)}
                        />
                        <ActionButton
                          action="stop"
                          assignmentId={container.assignmentId}
                          allowed={container.allowedActions.includes("stop")}
                          loading={actionMutation.isPending}
                          onClick={() => setConfirmStop({ assignmentId: container.assignmentId, name: container.name })}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmStop !== null}
        onClose={() => setConfirmStop(null)}
        onConfirm={() => {
          if (confirmStop) actionMutation.mutate({ assignmentId: confirmStop.assignmentId, action: "stop" });
          setConfirmStop(null);
        }}
        title={`Stop ${confirmStop?.name ?? "this container"}?`}
        impact="This will stop the container until it is started again."
        confirmLabel="Stop"
        danger
      />
    </div>
  );
}

function ActionButton({
  action,
  assignmentId,
  loading,
  allowed,
  onClick
}: {
  action: "start" | "stop" | "restart";
  assignmentId: string;
  loading: boolean;
  allowed: boolean;
  onClick: (input: { assignmentId: string; action: "start" | "stop" | "restart" }) => void;
}): React.JSX.Element {
  const variant = action === "stop" ? "danger" : "secondary";

  return (
    <Button
      disabled={!allowed || loading}
      size="sm"
      variant={variant}
      onClick={() => onClick({ assignmentId, action })}
    >
      {action}
    </Button>
  );
}
