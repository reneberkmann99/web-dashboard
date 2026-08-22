"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetcher";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type Column } from "@/components/ui/data-table";
import { WorkloadNetworksTab, WorkloadVolumesTab } from "@/components/workloads/networks-volumes-tabs";
import { TabBar } from "@/components/ui/tab-bar";
import { DeploymentsTab } from "@/components/workloads/deployment/deployments-tab";
import { SecretsTab } from "@/components/workloads/deployment/secrets-tab";
import { RollbackFlow } from "@/components/workloads/deployment/rollback-flow";
import { containerCard } from "@/components/mobile/mobile-resource-cards";
import type { WorkloadSummary, ContainerView } from "@/types/domain";
import { PageHeader } from "@/components/ui/page-header";
import { Breadcrumbs } from "@/components/navigation/breadcrumbs";
import { useOptionalNavigation, useResourceNavigation } from "@/components/navigation/navigation-context";
import { useDetailTab } from "@/components/navigation/view-state";

type WorkloadsPayload = { workloads: WorkloadSummary[] };
type ContainersPayload = { containers: ContainerView[] };
type ClientDeploymentStatus = {
  managed: boolean;
  deploymentId: string | null;
  isOwner: boolean;
  runtimeState: string | null;
  activeOperation: { id: string; type: string; state: string; phase: string | null; actorEmail: string | null; startedAt: string | null } | null;
};

const TABS = ["Containers", "Deployments", "Secrets", "Networks", "Volumes"] as const;
const CLIENT_API_BASE = "/api/client/deployments";

export default function ClientWorkloadDetailPage(): React.JSX.Element {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [tab, setTab] = useDetailTab(TABS, "Containers");
  const [rollbackOpen, setRollbackOpen] = useState(false);

  useEffect(() => {
    if (searchParams.get("rollback") === "1") {
      setRollbackOpen(true);
      const next = new URLSearchParams(searchParams.toString());
      next.delete("rollback");
      router.replace(`/client/workloads/${params.id}${next.size ? `?${next}` : ""}`, { scroll: false });
    }
  }, [searchParams, params.id, router]);

  const workloads = useQuery({
    queryKey: ["client-workloads"],
    queryFn: () => apiFetch<WorkloadsPayload>("/api/client/workloads")
  });
  const containers = useQuery({
    queryKey: ["client-containers"],
    queryFn: () => apiFetch<ContainersPayload>("/api/client/containers"),
    refetchInterval: 10000
  });
  const deploymentStatus = useQuery({
    queryKey: ["client-workload-deployment", params.id],
    queryFn: () => apiFetch<ClientDeploymentStatus>(`/api/client/workloads/${params.id}/deployment`)
  });

  const workload = workloads.data?.workloads.find((w) => w.id === params.id);
  const nav = useOptionalNavigation();
  const go = useResourceNavigation();
  useEffect(() => {
    if (workload?.name) nav?.renameCurrent(workload.name);
  }, [workload?.name, nav]);
  const workloadContainers = useMemo(() => {
    if (!workload) return [];
    return (containers.data?.containers ?? []).filter((c) => c.projectName === workload.name);
  }, [workload, containers.data]);

  if (workloads.isLoading) return <div className="h-40 animate-pulse rounded-lg bg-panelAlt" />;
  if (!workload) return <p className="text-sm text-critical-foreground">Workload not found or not accessible.</p>;

  const deployment = deploymentStatus.data;
  // Deployment lifecycle tabs only for workloads this client OWNS (not merely granted).
  const canManageDeployment = Boolean(deployment?.managed && deployment.isOwner && deployment.deploymentId);

  const columns: Column<ContainerView>[] = [
    { key: "name", header: "Container", render: (c) => <div><p className="font-medium">{c.name}</p><p className="text-xs text-muted">{c.containerId.slice(0, 12)}</p></div> },
    { key: "status", header: "Status", render: (c) => <Badge variant={c.status === "running" ? "success" : c.status === "stopped" ? "danger" : "warning"}>{c.status}</Badge> },
    { key: "cpu", header: "CPU", render: (c) => <span className="text-sm">{c.cpuPercent !== null ? `${c.cpuPercent.toFixed(1)}%` : "—"}</span>, hideBelow: "sm" },
    { key: "mem", header: "Memory", render: (c) => <span className="text-sm">{c.memoryUsage ?? "—"}</span>, hideBelow: "sm" }
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Workload"
        title={workload.name}
        back={<Breadcrumbs />}
        description={<span>{workload.nodeName} · <span className="font-mono">{workload.runningContainers}/{workload.totalContainers}</span> running</span>}
        actions={<>
          <Badge variant={workload.health === "healthy" ? "success" : workload.health === "degraded" ? "warning" : "danger"}>{workload.health}</Badge>
          {deployment?.managed && (
            <Badge variant={deployment.runtimeState === "CONVERGED" ? "success" : deployment.runtimeState === "DEGRADED" ? "warning" : "default"}>
              {deployment.runtimeState ?? "UNMANAGED"}
            </Badge>
          )}
        </>}
      />

      {/* Tab bar — above the panels so its position never shifts with content height */}
      <TabBar
        tabs={canManageDeployment ? TABS : TABS.filter((t) => t !== "Deployments" && t !== "Secrets")}
        active={tab}
        onChange={setTab}
        idPrefix="client-workload"
      />

      {tab === "Containers" && (
        <DataTable
          columns={columns}
          rows={workloadContainers}
          searchableText={(c) => c.name}
          searchPlaceholder="Search containers…"
          loading={containers.isLoading}
          emptyTitle="No containers in this workload"
          emptyBody="This workload has no containers visible to you."
          stateKey={`client-workload:${workload.id}:containers`}
          ariaLabel={`${workload.name} containers`}
          onRowClick={(c) => {
            go({ url: `/client/containers/${c.assignmentId}`, label: c.name, type: "container", id: c.containerId });
          }}
          rowKey={(c) => c.containerId}
          mobileCard={(c) =>
            containerCard(c, () => {
              go({ url: `/client/containers/${c.assignmentId}`, label: c.name, type: "container", id: c.containerId });
            })
          }
        />
      )}

      {tab === "Deployments" &&
        (canManageDeployment && deployment?.deploymentId ? (
          <DeploymentsTab
            deploymentId={deployment.deploymentId}
            apiBase={CLIENT_API_BASE}
            editHref={`/client/workloads/${workload.id}/deployment/edit`}
            activeOperation={deployment.activeOperation}
          />
        ) : (
          <p className="text-sm text-muted">
            {deployment?.managed
              ? "You have access to this workload's containers, but not to manage its deployment lifecycle."
              : "This workload is not managed by Noderaft and has no deployment lifecycle."}
          </p>
        ))}

      {tab === "Secrets" &&
        (canManageDeployment && deployment?.deploymentId ? (
          <SecretsTab deploymentId={deployment.deploymentId} apiBase={CLIENT_API_BASE} />
        ) : (
          <p className="text-sm text-muted">This workload has no Noderaft-managed secrets you can manage.</p>
        ))}

      {tab === "Networks" && (
        <WorkloadNetworksTab resourcesUrl={`/api/client/workloads/${workload.id}/resources`} />
      )}

      {tab === "Volumes" && (
        <WorkloadVolumesTab resourcesUrl={`/api/client/workloads/${workload.id}/resources`} />
      )}

      {rollbackOpen && canManageDeployment && deployment?.deploymentId && (
        <RollbackFlow
          deploymentId={deployment.deploymentId}
          apiBase={CLIENT_API_BASE}
          onDone={() => setRollbackOpen(false)}
        />
      )}
    </div>
  );
}
