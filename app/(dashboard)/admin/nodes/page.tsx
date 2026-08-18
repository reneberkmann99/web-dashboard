"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/lib/fetcher";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Modal } from "@/components/ui/modal";
import { timeAgo } from "@/lib/format";
import type { NodeRecord } from "@/types/domain";

type NodesPayload = { nodes: NodeRecord[] };
type EnrollmentResponse = { token: string; expiresAt: string; ttlMinutes: number; nodeId: string | null };

export default function AdminNodesPage(): React.JSX.Element {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [enrollment, setEnrollment] = useState<EnrollmentResponse | null>(null);

  const query = useQuery({
    queryKey: ["admin-nodes"],
    queryFn: () => apiFetch<NodesPayload>("/api/admin/nodes")
  });

  const enrollMutation = useMutation({
    mutationFn: () =>
      apiFetch<EnrollmentResponse>("/api/admin/nodes/enroll-token", {
        method: "POST",
        body: JSON.stringify({})
      }),
    onSuccess: (data) => {
      toast.success("Enrollment token created (valid 15 minutes)");
      setEnrollment(data);
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Failed to create token")
  });

  const patchMutation = useMutation({
    mutationFn: (input: { id: string; isActive: boolean }) =>
      apiFetch<{ success: boolean }>(`/api/admin/nodes/${input.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: input.isActive })
      }),
    onSuccess: () => {
      toast.success("Node state updated");
      queryClient.invalidateQueries({ queryKey: ["admin-nodes"] });
    }
  });

  const controlPlaneUrl = typeof window !== "undefined" ? window.location.origin : "http://172.28.0.1:1337";
  const enrollmentCommand = enrollment
    ? [
        "docker run -d --name hostpanel-agent \\",
        "  --restart unless-stopped \\",
        `  -e CONTROL_PLANE_URL=${controlPlaneUrl} \\`,
        `  -e AGENT_ENROLL_TOKEN=${enrollment.token} \\`,
        "  -e AGENT_DOCKER_MODE=rootless \\",
        "  -e DOCKER_HOST=unix:///var/run/docker.sock \\",
        "  -e AGENT_KEY_FILE=/data/agent.key \\",
        "  -v /var/run/docker.sock:/var/run/docker.sock:rw \\",
        "  -v hostpanel-agent-data:/data \\",
        "  ghcr.io/reneberkmann99/hostpanel-agent:latest"
      ].join("\n")
    : null;

  const columns: Column<NodeRecord>[] = [
    {
      key: "name",
      header: "Node",
      sortValue: (n) => n.name,
      render: (n) => (
        <div>
          <p className="font-medium">{n.name}</p>
          <p className="text-xs text-muted">{n.hostname}</p>
        </div>
      )
    },
    {
      key: "status",
      header: "State",
      sortValue: (n) => n.status,
      render: (n) => (
        <Badge variant={n.status === "ONLINE" ? "success" : n.status === "OFFLINE" ? "danger" : n.status === "INACTIVE" ? "default" : "warning"}>
          {n.status.toLowerCase()}
        </Badge>
      )
    },
    {
      key: "heartbeat",
      header: "Last heartbeat",
      sortValue: (n) => n.lastHeartbeatAt ?? "",
      render: (n) => <span className="text-sm">{timeAgo(n.lastHeartbeatAt)}</span>,
      hideBelow: "sm"
    },
    {
      key: "versions",
      header: "Versions",
      hideBelow: "md",
      render: (n) => (
        <span className="text-xs text-muted">
          agent {n.agentVersion ?? "?"}
          <span className="block">docker {n.dockerVersion ?? "?"}</span>
        </span>
      )
    },
    {
      key: "containers",
      header: "Containers",
      sortValue: (n) => n.liveContainerCount,
      render: (n) => <span className="text-sm">{n.liveContainerCount}</span>
    },
    {
      key: "actions",
      header: "",
      render: (n) => (
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => router.push(`/admin/nodes/${n.id}`)}>
            Open
          </Button>
          {n.isActive && (
            <Button size="sm" variant="danger" onClick={() => patchMutation.mutate({ id: n.id, isActive: false })}>
              Disable
            </Button>
          )}
        </div>
      )
    }
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold">Nodes</h1>
          <p className="text-muted">Where your workloads run, and whether those hosts are healthy.</p>
        </div>
        <Button onClick={() => setEnrollOpen(true)}>Add node</Button>
      </div>

      <DataTable
        columns={columns}
        rows={query.data?.nodes ?? []}
        searchableText={(n) => `${n.name} ${n.hostname}`}
        searchPlaceholder="Search nodes…"
        loading={query.isLoading}
        error={query.isError ? "Failed to load nodes" : null}
        emptyTitle="No nodes yet"
        emptyBody="Install the HostPanel agent on your first Docker server to begin managing workloads."
        emptyAction={<Button onClick={() => setEnrollOpen(true)}>Add node</Button>}
        rowKey={(n) => n.id}
      />

      <Modal
        open={enrollOpen}
        onClose={() => {
          setEnrollOpen(false);
          setEnrollment(null);
        }}
        title="Add node"
        description="Generate a short-lived one-time token, then run the enrollment command on the target host. The agent registers itself and receives its own API key — you never create or see the key."
        footer={
          enrollment ? (
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  void navigator.clipboard.writeText(enrollmentCommand ?? "");
                  toast.success("Command copied");
                }}
              >
                Copy command
              </Button>
              <Button
                onClick={() => {
                  setEnrollOpen(false);
                  setEnrollment(null);
                }}
              >
                Done
              </Button>
            </>
          ) : (
            <Button onClick={() => enrollMutation.mutate()} disabled={enrollMutation.isPending}>
              {enrollMutation.isPending ? "Generating…" : "Generate enrollment token"}
            </Button>
          )
        }
      >
        {enrollment ? (
          <div className="space-y-3">
            <p className="text-sm">
              Run this on the node host. The token expires at{" "}
              <strong>{new Date(enrollment.expiresAt).toLocaleString()}</strong> and can only be used once.
            </p>
            <pre className="overflow-x-auto rounded border border-border bg-black/40 p-3 text-xs text-slate-200">
              {enrollmentCommand}
            </pre>
          </div>
        ) : (
          <p className="text-sm text-muted">
            For compose-managed agents, set <code>CONTROL_PLANE_URL</code>, <code>AGENT_ENROLL_TOKEN</code> and{" "}
            <code>AGENT_KEY_FILE</code> on the agent service.
          </p>
        )}
      </Modal>
    </div>
  );
}
