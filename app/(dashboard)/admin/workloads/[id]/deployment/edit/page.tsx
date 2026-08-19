"use client";

import { useParams, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetcher";
import { Button } from "@/components/ui/button";
import { DeploymentEditor } from "@/components/workloads/deployment/deployment-editor";
import type { WorkloadDeploymentStatus } from "@/components/workloads/deployment/types";

export default function AdminDeploymentEditPage(): React.JSX.Element {
  const params = useParams<{ id: string }>();
  const router = useRouter();

  const workload = useQuery({
    queryKey: ["workload", params.id],
    queryFn: () =>
      apiFetch<{
        workload: { id: string; name: string; node: { id: string } };
        deployment: WorkloadDeploymentStatus;
      }>(`/api/admin/workloads/${params.id}`)
  });

  if (workload.isLoading) return <div className="h-40 animate-pulse rounded-lg bg-panelAlt" />;
  if (workload.isError || !workload.data) return <p className="text-sm text-red-400">Failed to load workload.</p>;

  const { deployment } = workload.data;
  if (!deployment.managed || !deployment.deploymentId) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted">This workload is not managed by HostPanel and has no deployment lifecycle.</p>
        <Button size="sm" variant="secondary" onClick={() => router.push(`/admin/workloads/${params.id}`)}>
          ← Back to workload
        </Button>
      </div>
    );
  }

  return (
    <DeploymentEditor
      workloadName={workload.data.workload.name}
      deploymentId={deployment.deploymentId}
      nodeId={workload.data.workload.node.id}
      activeOperation={deployment.activeOperation}
      apiBase="/api/admin/deployments"
      validateUrl="/api/admin/deployments/validate"
      backHref={`/admin/workloads/${params.id}`}
      rollbackHref={`/admin/workloads/${params.id}?rollback=1`}
    />
  );
}
