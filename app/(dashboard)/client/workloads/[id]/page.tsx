"use client";

import { useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetcher";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { WorkloadNetworksTab, WorkloadVolumesTab } from "@/components/workloads/networks-volumes-tabs";
import { TabBar } from "@/components/ui/tab-bar";
import type { WorkloadSummary, ContainerView } from "@/types/domain";

type WorkloadsPayload = { workloads: WorkloadSummary[] };
type ContainersPayload = { containers: ContainerView[] };

const TABS = ["Containers", "Networks", "Volumes"] as const;

export default function ClientWorkloadDetailPage(): React.JSX.Element {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [tab, setTab] = useState<(typeof TABS)[number]>("Containers");

  const workloads = useQuery({
    queryKey: ["client-workloads"],
    queryFn: () => apiFetch<WorkloadsPayload>("/api/client/workloads")
  });
  const containers = useQuery({
    queryKey: ["client-containers"],
    queryFn: () => apiFetch<ContainersPayload>("/api/client/containers"),
    refetchInterval: 10000
  });

  const workload = workloads.data?.workloads.find((w) => w.id === params.id);
  const workloadContainers = useMemo(() => {
    if (!workload) return [];
    return (containers.data?.containers ?? []).filter((c) => c.projectName === workload.name);
  }, [workload, containers.data]);

  if (workloads.isLoading) return <div className="h-40 animate-pulse rounded-lg bg-panelAlt" />;
  if (!workload) return <p className="text-sm text-red-400">Workload not found or not accessible.</p>;

  const columns: Column<ContainerView>[] = [
    { key: "name", header: "Container", render: (c) => <div><p className="font-medium">{c.name}</p><p className="text-xs text-muted">{c.containerId.slice(0, 12)}</p></div> },
    { key: "status", header: "Status", render: (c) => <Badge variant={c.status === "running" ? "success" : c.status === "stopped" ? "danger" : "warning"}>{c.status}</Badge> },
    { key: "cpu", header: "CPU", render: (c) => <span className="text-sm">{c.cpuPercent !== null ? `${c.cpuPercent.toFixed(1)}%` : "—"}</span>, hideBelow: "sm" },
    { key: "mem", header: "Memory", render: (c) => <span className="text-sm">{c.memoryUsage ?? "—"}</span>, hideBelow: "sm" }
  ];

  return (
    <div className="space-y-6">
      <div>
        <button type="button" onClick={() => router.push("/client/workloads")} className="mb-1 text-sm text-accent hover:underline">
          ← Workloads
        </button>
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-semibold">{workload.name}</h1>
          <Badge variant={workload.health === "healthy" ? "success" : workload.health === "degraded" ? "warning" : "danger"}>{workload.health}</Badge>
        </div>
        <p className="text-muted">
          {workload.nodeName} · {workload.runningContainers}/{workload.totalContainers} running
        </p>
      </div>

      {tab === "Containers" && (
        <DataTable
          columns={columns}
          rows={workloadContainers}
          searchableText={(c) => c.name}
          searchPlaceholder="Search containers…"
          loading={containers.isLoading}
          emptyTitle="No containers in this workload"
          emptyBody="This workload has no containers visible to you."
          onRowClick={(c) => router.push(`/client/containers/${c.assignmentId}`)}
          rowKey={(c) => c.containerId}
        />
      )}

      {tab === "Networks" && (
        <WorkloadNetworksTab resourcesUrl={`/api/client/workloads/${workload.id}/resources`} />
      )}

      {tab === "Volumes" && (
        <WorkloadVolumesTab resourcesUrl={`/api/client/workloads/${workload.id}/resources`} />
      )}

      <TabBar tabs={TABS} active={tab} onChange={setTab} idPrefix="client-workload" />
    </div>
  );
}
