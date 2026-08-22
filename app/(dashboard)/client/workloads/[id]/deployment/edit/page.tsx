"use client";

import { useParams, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetcher";
import { Button } from "@/components/ui/button";
import { DeploymentEditor } from "@/components/workloads/deployment/deployment-editor";
import type { WorkloadSummary } from "@/types/domain";

type WorkloadsPayload = { workloads: WorkloadSummary[] };
type ClientDeploymentStatus = {
  managed: boolean;
  deploymentId: string | null;
  isOwner: boolean;
  activeOperation: { id: string; type: string; state: string; phase: string | null; actorEmail: string | null; startedAt: string | null } | null;
};

export default function ClientDeploymentEditPage(): React.JSX.Element {
  const params = useParams<{ id: string }>();
  const router = useRouter();

  const workloads = useQuery({
    queryKey: ["client-workloads"],
    queryFn: () => apiFetch<WorkloadsPayload>("/api/client/workloads")
  });
  const deploymentStatus = useQuery({
    queryKey: ["client-workload-deployment", params.id],
    queryFn: () => apiFetch<ClientDeploymentStatus>(`/api/client/workloads/${params.id}/deployment`)
  });

  const workload = workloads.data?.workloads.find((w) => w.id === params.id);

  if (workloads.isLoading || deploymentStatus.isLoading) return <div className="h-40 animate-pulse rounded-lg bg-panelAlt" />;
  if (!workload) return <p className="text-sm text-critical-foreground">Workload not found or not accessible.</p>;

  const deployment = deploymentStatus.data;
  if (!deployment?.managed || !deployment.isOwner || !deployment.deploymentId) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted">
          {deployment?.managed
            ? "You don't have permission to manage this workload's deployment."
            : "This workload is not managed by Noderaft and has no deployment lifecycle."}
        </p>
        <Button size="sm" variant="secondary" onClick={() => router.push(`/organization/workloads/${params.id}`)}>
          ← Back to workload
        </Button>
      </div>
    );
  }

  return (
    <DeploymentEditor
      workloadName={workload.name}
      deploymentId={deployment.deploymentId}
      nodeId={workload.nodeId}
      activeOperation={deployment.activeOperation}
      apiBase="/api/client/deployments"
      validateUrl="/api/client/deployments/validate"
      backHref={`/organization/workloads/${params.id}`}
      rollbackHref={`/organization/workloads/${params.id}?rollback=1`}
    />
  );
}
