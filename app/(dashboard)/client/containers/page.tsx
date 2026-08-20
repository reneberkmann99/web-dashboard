"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/lib/fetcher";
import type { ContainerView } from "@/types/domain";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PageHeader } from "@/components/ui/page-header";
import { DataTable, type Column } from "@/components/ui/data-table";
import { rememberResourceNavigation } from "@/components/navigation/view-state";

type ListResponse = {
  containers: ContainerView[];
};

export default function ClientContainersPage(): React.JSX.Element {
  const router = useRouter();
  const queryClient = useQueryClient();
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

  const columns: Column<ContainerView>[] = [
    {
      key: "name",
      header: "Container",
      render: (container) => (
        <div>
          <p className="font-medium text-text">{container.name}</p>
          <p className="max-w-xs truncate font-mono text-xs text-text-subtle">{container.image}</p>
        </div>
      )
    },
    {
      key: "status",
      header: "Status",
      render: (container) => (
        <div className="flex items-center gap-2">
          <StatusBadge status={container.status} />
          {!container.nodeOnline ? <Badge variant="danger">Node offline</Badge> : null}
        </div>
      )
    },
    { key: "uptime", header: "Uptime", render: (container) => <span className="font-mono text-sm">{container.uptime ?? "—"}</span>, hideBelow: "sm" },
    { key: "cpu", header: "CPU", render: (container) => <span className="font-mono text-sm">{container.cpuPercent !== null ? `${container.cpuPercent.toFixed(2)}%` : "—"}</span>, hideBelow: "md" },
    { key: "memory", header: "Memory", render: (container) => <span className="font-mono text-sm">{container.memoryUsage ?? "—"}</span>, hideBelow: "md" },
    { key: "ports", header: "Ports", render: (container) => <span className="font-mono text-sm">{container.ports || "—"}</span>, hideBelow: "lg" },
    { key: "node", header: "Node", render: (container) => container.nodeName, hideBelow: "lg" },
    {
      key: "actions",
      header: "Actions",
      render: (container) => (
        <div className="flex gap-2" data-row-action>
          <ActionButton action="start" assignmentId={container.assignmentId} allowed={container.allowedActions.includes("start")} loading={actionMutation.isPending} onClick={(input) => actionMutation.mutate(input)} />
          <ActionButton action="restart" assignmentId={container.assignmentId} allowed={container.allowedActions.includes("restart")} loading={actionMutation.isPending} onClick={(input) => actionMutation.mutate(input)} />
          <ActionButton action="stop" assignmentId={container.assignmentId} allowed={container.allowedActions.includes("stop")} loading={actionMutation.isPending} onClick={() => setConfirmStop({ assignmentId: container.assignmentId, name: container.name })} />
        </div>
      )
    }
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Runtime inventory"
        title="Containers"
        description="Status, resource metrics, and controls for your assigned services."
      />

      <DataTable
        columns={columns}
        rows={query.data?.containers ?? []}
        loading={query.isLoading}
        searchableText={(container) => `${container.name} ${container.image} ${container.nodeName}`}
        searchPlaceholder="Search containers…"
        emptyTitle={query.isError ? "Failed to load containers" : "No containers assigned yet"}
        emptyBody={query.isError ? "The inventory could not be loaded. Try again shortly." : "Assigned services will appear here."}
        stateKey="client-containers"
        ariaLabel="Assigned containers"
        rowKey={(container) => container.assignmentId}
        onRowClick={(container) => {
          const destination = `/client/containers/${container.assignmentId}`;
          rememberResourceNavigation(destination);
          router.push(destination);
        }}
      />

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
