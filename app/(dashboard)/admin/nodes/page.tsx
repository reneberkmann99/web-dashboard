"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/lib/fetcher";
import { Badge } from "@/components/ui/badge";
import { AttentionBadge } from "@/components/ui/attention-badge";
import { Button } from "@/components/ui/button";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Modal } from "@/components/ui/modal";
import { timeAgo } from "@/lib/format";
import type { NodeRecord } from "@/types/domain";
import { PageHeader } from "@/components/ui/page-header";
import { Menu } from "@/components/ui/menu";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { rememberResourceNavigation } from "@/components/navigation/view-state";

type NodesPayload = { nodes: NodeRecord[] };
type EnrollmentResponse = { token: string; expiresAt: string; ttlMinutes: number; nodeId: string | null };

export default function AdminNodesPage(): React.JSX.Element {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [enrollment, setEnrollment] = useState<EnrollmentResponse | null>(null);
  const [confirmDisable, setConfirmDisable] = useState<NodeRecord | null>(null);

  const query = useQuery({
    queryKey: ["admin-nodes"],
    queryFn: () => apiFetch<NodesPayload>("/api/admin/nodes"),
    refetchInterval: 20000
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

  const controlPlaneUrl = typeof window !== "undefined" ? window.location.origin : "";
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
      key: "attention",
      header: "Attention",
      sortValue: (n) => ({ critical: 0, warning: 1, info: 2, unknown: 3, healthy: 4 }[n.attention] ?? 3),
      render: (n) => (n.attention === "healthy" ? <span className="text-xs text-muted">No issues</span> : <AttentionBadge severity={n.attention} />)
    },
    {
      key: "heartbeat",
      header: "Last heartbeat",
      sortValue: (n) => n.lastHeartbeatAt ?? "",
      render: (n) => <span className="text-sm">{timeAgo(n.lastHeartbeatAt)}</span>,
      hideBelow: "sm"
    },
    {
      key: "resources",
      header: "Resources",
      hideBelow: "md",
      render: (n) => {
        if (n.offline || n.staleHeartbeat) {
          return <span className="text-xs text-muted">Telemetry stale · {timeAgo(n.lastHeartbeatAt)}</span>;
        }
        const sys = (n.systemInfo ?? {}) as Record<string, unknown>;
        const cpu = typeof sys.cpuPercent === "number" ? `${sys.cpuPercent.toFixed(0)}% CPU` : null;
        const mem = typeof sys.memPercent === "number" ? `${sys.memPercent.toFixed(0)}% RAM` : null;
        const disk = typeof sys.diskPercent === "number" ? `${sys.diskPercent.toFixed(0)}% disk` : null;
        const parts = [cpu, mem, disk].filter(Boolean);
        return <span className="font-mono text-xs text-muted">{parts.length > 0 ? parts.join(" · ") : "—"}</span>;
      }
    },
    {
      key: "versions",
      header: "Versions",
      hideBelow: "lg",
      render: (n) => (
        <span className="font-mono text-xs text-muted">
          agent {n.agentVersion ?? "?"}
          <span className="block">docker {n.dockerVersion ?? "?"}</span>
        </span>
      )
    },
    {
      key: "containers",
      header: "Containers",
      sortValue: (n) => n.liveContainerCount,
      render: (n) => (
        <span className="font-mono text-sm">
          {n.liveContainerCount}
          <span className="ml-1 text-xs text-muted">{n.liveWorkloadCount ?? 0} workloads</span>
        </span>
      )
    },
    {
      key: "actions",
      header: "",
      render: (n) => (
        <div className="flex justify-end">
          <Menu
            label={`Actions for ${n.name}`}
            items={n.isActive ? [
              { label: "Disable node", tone: "danger", onSelect: () => setConfirmDisable(n) }
            ] : [
              { label: "Enable node", onSelect: () => patchMutation.mutate({ id: n.id, isActive: true }) }
            ]}
          />
        </div>
      )
    }
  ];

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Fleet" title="Nodes" description="Where your workloads run, and whether those hosts need attention." actions={<Button onClick={() => setEnrollOpen(true)}>Add node</Button>} />

      <DataTable
        columns={columns}
        rows={query.data?.nodes ?? []}
        searchableText={(n) => `${n.name} ${n.hostname}`}
        searchPlaceholder="Search nodes…"
        loading={query.isLoading}
        error={query.isError ? "Failed to load nodes" : null}
        emptyTitle="No nodes yet"
        emptyBody="Install Noderaft Agent on your first Docker server to begin managing workloads."
        emptyAction={<Button onClick={() => setEnrollOpen(true)}>Add node</Button>}
        rowKey={(n) => n.id}
        stateKey="admin-nodes"
        ariaLabel="Nodes"
        initialSort="attention"
        initialSortDir="asc"
        onRowClick={(node) => {
          const href = `/admin/nodes/${node.id}`;
          rememberResourceNavigation(href);
          router.push(href);
        }}
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
            <pre className="overflow-x-auto rounded border border-border bg-surface-hull/75 p-3 text-xs text-text">
              {enrollmentCommand}
            </pre>
          </div>
        ) : (
          <p className="text-sm text-muted">
            For compose-managed agents, set <code>CONTROL_PLANE_URL</code>, <code>AGENT_ENROLL_TOKEN</code> and{" "}
            <code>AGENT_KEY_FILE</code> on the Noderaft Agent service.
          </p>
        )}
      </Modal>

      <ConfirmDialog
        open={confirmDisable !== null}
        onClose={() => setConfirmDisable(null)}
        onConfirm={() => {
          if (confirmDisable) patchMutation.mutate({ id: confirmDisable.id, isActive: false });
          setConfirmDisable(null);
        }}
        title={`Disable ${confirmDisable?.name ?? "node"}?`}
        impact="Noderaft will stop polling and operating this node until it is enabled again. Running containers are not stopped."
        confirmLabel="Disable node"
        danger
      />
    </div>
  );
}
