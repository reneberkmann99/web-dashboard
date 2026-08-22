"use client";

import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useResourceNavigation } from "@/components/navigation/navigation-context";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/lib/fetcher";
import { Badge } from "@/components/ui/badge";
import { AttentionBadge } from "@/components/ui/attention-badge";
import { Button } from "@/components/ui/button";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Modal } from "@/components/ui/modal";
import { timeAgo, cleanVersion } from "@/lib/format";
import { freshnessAgeLabel } from "@/lib/freshness";
import type { NodeRecord } from "@/types/domain";
import { PageHeader } from "@/components/ui/page-header";
import { Menu } from "@/components/ui/menu";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ResourceUsageStrip } from "@/components/ui/resource-usage";
import type { ResourceThresholds } from "@/types/domain";
import { nodeCard } from "@/components/mobile/mobile-resource-cards";
import { DesktopFilterBar } from "@/components/ui/desktop-filter-bar";
import { Input } from "@/components/ui/input";

type NodesPayload = { resourceThresholds: ResourceThresholds; nodes: NodeRecord[] };
type EnrollmentResponse = { token: string; expiresAt: string; ttlMinutes: number; nodeId: string | null };

export default function AdminNodesPage(): React.JSX.Element {
  const go = useResourceNavigation();
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [enrollment, setEnrollment] = useState<EnrollmentResponse | null>(null);
  const [confirmDisable, setConfirmDisable] = useState<NodeRecord | null>(null);
  const [search, setSearch] = useState(searchParams.get("search") ?? "");
  const [nodeState, setNodeState] = useState(searchParams.get("state") ?? "");

  useEffect(() => {
    setSearch(searchParams.get("search") ?? "");
    setNodeState(searchParams.get("state") ?? "");
  }, [searchParams]);

  const updateSearch = (value: string): void => {
    setSearch(value);
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set("search", value);
    else params.delete("search");
    const searchString = params.toString();
    router.push(searchString ? `/admin/nodes?${searchString}` : "/admin/nodes", { scroll: false });
  };
  const updateState = (value: string): void => {
    setNodeState(value);
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set("state", value);
    else params.delete("state");
    const searchString = params.toString();
    router.push(searchString ? `/admin/nodes?${searchString}` : "/admin/nodes", { scroll: false });
  };

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
        <p className="truncate font-medium text-text">{n.name}<span className="ml-2 font-mono text-[11px] font-normal text-text-subtle">{n.hostname}</span></p>
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
      omitWhenEmpty: (n) => n.attention === "healthy",
      render: (n) => (n.attention === "healthy" ? null : <AttentionBadge severity={n.attention} />)
    },
    {
      key: "heartbeat",
      header: "Last heartbeat",
      sortValue: (n) => n.lastHeartbeatAt ?? "",
      render: (n) => <span className="text-sm">{freshnessAgeLabel(n.lastHeartbeatAt)}</span>,
      hideBelow: "sm"
    },
    {
      key: "resources",
      header: "Resources",
      hideBelow: "md",
      render: (n) => {
        if (n.offline || n.staleHeartbeat) {
          return <span className="text-xs text-text-muted">Telemetry stale · {freshnessAgeLabel(n.lastHeartbeatAt)}</span>;
        }
        const sys = (n.systemInfo ?? {}) as Record<string, unknown>;
        const cpu = typeof sys.cpuPercent === "number" ? sys.cpuPercent : null;
        const mem = typeof sys.memPercent === "number" ? sys.memPercent : null;
        const disk = typeof sys.diskPercent === "number" ? sys.diskPercent : null;
        return (
          <ResourceUsageStrip
            cpuPercent={cpu}
            memPercent={mem}
            diskPercent={disk}
            telemetryCurrent
            thresholds={query.data?.resourceThresholds ?? {
              cpu: { warning: 85, critical: 97 },
              mem: { warning: 85, critical: 95 },
              disk: { warning: 85, critical: 95 }
            }}
          />
        );
      }
    },
    {
      key: "versions",
      header: "Versions",
      hideBelow: "lg",
      render: (n) => (
        <span className="font-mono text-xs text-muted">
          agent {cleanVersion(n.agentVersion) ?? "?"}
          <span className="block">docker {cleanVersion(n.dockerVersion) ?? "?"}</span>
        </span>
      )
    },
    {
      key: "containers",
      header: "Containers",
      className: "text-right",
      sortValue: (n) => n.liveContainerCount,
      render: (n) => <span className="font-mono text-sm tabular-nums">{n.liveContainerCount}</span>
    },
    {
      key: "workloads",
      header: "Workloads",
      className: "text-right",
      sortValue: (n) => n.liveWorkloadCount ?? 0,
      render: (n) => <span className="font-mono text-sm tabular-nums text-text-muted">{n.liveWorkloadCount ?? 0}</span>
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

  const thresholds = query.data?.resourceThresholds ?? {
    cpu: { warning: 85, critical: 97 },
    mem: { warning: 85, critical: 95 },
    disk: { warning: 85, critical: 95 }
  };
  const allNodes = query.data?.nodes ?? [];
  const visibleNodes = allNodes.filter((node) => {
    if (search && !`${node.name} ${node.hostname}`.toLowerCase().includes(search.toLowerCase())) return false;
    if (nodeState && node.status.toLowerCase() !== nodeState) return false;
    return true;
  });

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Fleet" title="Nodes" count={allNodes.length} description="Hosts reporting runtime and resource telemetry." actions={<span className="max-md:hidden"><Button onClick={() => setEnrollOpen(true)}>Add node</Button></span>} />

      <DesktopFilterBar search={search} onSearchChange={updateSearch} searchPlaceholder="Search nodes…" dimensions={[{ id: "state", label: "State", value: nodeState, options: [{ value: "online", label: "Online" }, { value: "offline", label: "Offline" }, { value: "unknown", label: "Unknown" }, { value: "inactive", label: "Inactive" }], onChange: updateState }]} resultCount={visibleNodes.length} totalCount={allNodes.length} onClearAll={() => { setSearch(""); setNodeState(""); router.push("/admin/nodes", { scroll: false }); }} />
      <div className="md:hidden"><Input type="search" value={search} onChange={(event) => updateSearch(event.target.value)} placeholder="Search nodes…" aria-label="Search nodes…" /></div>

      <DataTable
        columns={columns}
        rows={visibleNodes}
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
          go({ url: `/admin/nodes/${node.id}`, label: node.name, type: "node", id: node.id });
        }}
        mobileCard={(node) =>
          nodeCard(node, thresholds, () => {
            go({ url: `/admin/nodes/${node.id}`, label: node.name, type: "node", id: node.id });
          })
        }
      />

      {/* Design §06: dashed "Add node" card below the mobile node list */}
      <button
        type="button"
        onClick={() => setEnrollOpen(true)}
        className="flex h-12 w-full items-center justify-center gap-2 rounded-[12px] border border-dashed border-border-strong/70 text-[15px] text-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus md:hidden"
      >
        <Plus size={16} />
        Add node
      </button>

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
