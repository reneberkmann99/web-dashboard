"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetcher";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ReleaseHistory } from "./release-history";
import { RollbackFlow } from "./rollback-flow";
import { RUNTIME_STATE_LABELS } from "./labels";
import { timeAgo } from "@/lib/format";
import type { DeploymentDetailPayload, ReleasesListPayload, RevisionDetailPayload } from "./types";

/**
 * Deployments tab — current state, active configuration, release history.
 * The full edit/deploy workflow lives on its own editor route.
 */
export function DeploymentsTab({ workloadId }: { workloadId: string }): React.JSX.Element {
  const router = useRouter();
  const [rollbackOpen, setRollbackOpen] = useState(false);

  const deploymentQuery = useQuery({
    queryKey: ["workload-deployment", workloadId],
    queryFn: () => apiFetch<{ deployment: WorkloadDeploymentStatusLike }>(`/api/admin/workloads/${workloadId}`).then((d) => d.deployment)
  });

  const deployment = deploymentQuery.data;
  const deploymentId = deployment?.deploymentId ?? null;

  const releases = useQuery({
    queryKey: ["deployment-releases", deploymentId],
    queryFn: () => apiFetch<ReleasesListPayload>(`/api/admin/deployments/${deploymentId}/releases?limit=100`),
    enabled: Boolean(deploymentId),
    refetchInterval: 15000
  });

  const currentRelease = releases.data?.data.find((r) => r.isCurrent) ?? null;

  const currentRevision = useQuery({
    queryKey: ["deployment-revision", deploymentId, currentRelease?.revisionId],
    queryFn: () => apiFetch<RevisionDetailPayload>(`/api/admin/deployments/${deploymentId}/revisions/${currentRelease!.revisionId}`),
    enabled: Boolean(deploymentId && currentRelease)
  });

  const detail = useQuery({
    queryKey: ["deployment-detail", deploymentId],
    queryFn: () => apiFetch<DeploymentDetailPayload>(`/api/admin/deployments/${deploymentId}`),
    enabled: Boolean(deploymentId)
  });

  if (deploymentQuery.isLoading) return <div className="h-40 animate-pulse rounded-lg bg-panelAlt" />;
  if (deploymentQuery.isError || !deployment) return <p className="text-sm text-red-400">Failed to load deployment state.</p>;
  if (!deployment.managed || !deploymentId) {
    return <p className="text-sm text-muted">This workload is not managed by HostPanel and has no deployment lifecycle.</p>;
  }

  const runtimeState = releases.data?.runtimeState ?? deployment.runtimeState ?? "UNKNOWN";

  return (
    <div className="space-y-6">
      {/* Current state */}
      <section className="rounded-lg border border-border bg-panel p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Current state</h2>
          <Badge variant={runtimeState === "CONVERGED" ? "success" : runtimeState === "DEGRADED" ? "warning" : runtimeState === "DRIFTED" ? "danger" : "default"}>
            {runtimeState}
          </Badge>
        </div>

        {releases.data && currentRelease ? (
          <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <p className="text-xs uppercase text-muted">Current release</p>
              <p className="font-medium">
                #{currentRelease.displayNumber}{" "}
                <Badge variant={currentRelease.healthVerdict === "HEALTHY" ? "success" : "warning"}>
                  {currentRelease.healthVerdict}
                </Badge>
              </p>
            </div>
            <div>
              <p className="text-xs uppercase text-muted">Revision</p>
              <p className="font-medium">{currentRelease.revisionNumber}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-muted">Deployed</p>
              <p>
                {timeAgo(currentRelease.appliedAt)} {currentRelease.actorEmail ? `by ${currentRelease.actorEmail}` : ""}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase text-muted">Runtime</p>
              <p className="text-muted">{RUNTIME_STATE_LABELS[runtimeState] ?? runtimeState}</p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted">This managed workload has not been deployed yet.</p>
        )}

        {releases.data && (
          <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
            {currentRelease && releases.data.lastHealthyReleaseId && releases.data.lastHealthyReleaseId !== currentRelease.id && (
              <div className="rounded border border-border bg-panelAlt p-2.5">
                <p className="text-xs uppercase text-muted">Last healthy</p>
                <p className="font-medium">
                  Release #{releases.data.data.find((r) => r.id === releases.data.lastHealthyReleaseId)?.displayNumber ?? "—"} · Revision{" "}
                  {releases.data.data.find((r) => r.id === releases.data.lastHealthyReleaseId)?.revisionNumber ?? "—"}
                </p>
              </div>
            )}
            {deployment.activeOperation && (
              <div className="rounded border border-warning/30 bg-warning/10 p-2.5">
                <p className="font-medium text-amber-200">
                  {deployment.activeOperation.type === "ROLLBACK" ? "Rollback" : "Deployment"} in progress
                  {deployment.activeOperation.actorEmail ? ` — ${deployment.activeOperation.actorEmail}` : ""}
                </p>
                <p className="mt-0.5 text-xs text-muted">New deployments are blocked while this operation is active.</p>
              </div>
            )}
          </div>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => router.push(`/admin/workloads/${workloadId}/deployment/edit`)}>
            Edit configuration
          </Button>
          {(runtimeState === "DEGRADED" || (currentRelease && currentRelease.healthVerdict === "DEGRADED")) && (
            <Button size="sm" variant="warning" onClick={() => setRollbackOpen(true)}>
              Rollback
            </Button>
          )}
        </div>
      </section>

      {/* Configuration */}
      <section className="rounded-lg border border-border bg-panel p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Configuration</h2>
          <Button size="sm" variant="secondary" onClick={() => router.push(`/admin/workloads/${workloadId}/deployment/edit`)}>
            Edit configuration
          </Button>
        </div>
        {currentRevision.isLoading && <p className="text-sm text-muted">Loading configuration…</p>}
        {currentRevision.data ? (
          <>
            <p className="mb-1 text-xs text-muted">
              Revision {currentRevision.data.revisionNumber}
              {currentRevision.data.deployNote ? ` — ${currentRevision.data.deployNote}` : ""}
              {" · "}Compose project <span className="font-mono">{detail.data?.composeProjectName ?? deploymentId}</span>
            </p>
            <pre className="max-h-72 overflow-auto rounded border border-border bg-panelAlt p-3 font-mono text-xs leading-relaxed">
              {currentRevision.data.composeSource}
            </pre>
          </>
        ) : currentRelease ? (
          <p className="text-sm text-red-400">Failed to load the active configuration.</p>
        ) : (
          <p className="text-sm text-muted">Create the first deployment from the editor.</p>
        )}
      </section>

      {/* Release history */}
      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">Release history</h2>
        <ReleaseHistory
          deploymentId={deploymentId}
          onRollback={() => setRollbackOpen(true)}
          emptyState="This managed workload has not been deployed yet."
        />
      </section>

      {rollbackOpen && (
        <RollbackFlow
          deploymentId={deploymentId}
          workloadId={workloadId}
          onDone={() => setRollbackOpen(false)}
        />
      )}
    </div>
  );
}

type WorkloadDeploymentStatusLike = {
  managed: boolean;
  deploymentId: string | null;
  runtimeState: string | null;
  activeOperation: { id: string; type: string; state: string; phase: string | null; actorEmail: string | null; startedAt: string | null } | null;
  [key: string]: unknown;
};
