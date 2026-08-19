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

export type DeploymentsTabActiveOperation = {
  id: string;
  type: string;
  state: string;
  phase: string | null;
  actorEmail: string | null;
  startedAt: string | null;
} | null;

/**
 * Deployments tab — current state, active configuration, release history.
 * The full edit/deploy workflow lives on its own editor route.
 *
 * `apiBase` selects the tenant scope (`/api/admin/deployments` or
 * `/api/client/deployments`); the caller supplies `deploymentId` and
 * `activeOperation` (already resolved from its own workload-status query) so
 * this component never has to guess which status endpoint to call.
 */
export function DeploymentsTab({
  deploymentId,
  editHref,
  apiBase = "/api/admin/deployments",
  activeOperation
}: {
  deploymentId: string;
  editHref: string;
  apiBase?: string;
  activeOperation?: DeploymentsTabActiveOperation;
}): React.JSX.Element {
  const router = useRouter();
  const [rollbackOpen, setRollbackOpen] = useState(false);

  const releases = useQuery({
    queryKey: ["deployment-releases", apiBase, deploymentId],
    queryFn: () => apiFetch<ReleasesListPayload>(`${apiBase}/${deploymentId}/releases?limit=100`),
    refetchInterval: 15000
  });

  const currentRelease = releases.data?.data.find((r) => r.isCurrent) ?? null;

  const currentRevision = useQuery({
    queryKey: ["deployment-revision", apiBase, deploymentId, currentRelease?.revisionId],
    queryFn: () => apiFetch<RevisionDetailPayload>(`${apiBase}/${deploymentId}/revisions/${currentRelease!.revisionId}`),
    enabled: Boolean(currentRelease)
  });

  const detail = useQuery({
    queryKey: ["deployment-detail", apiBase, deploymentId],
    queryFn: () => apiFetch<DeploymentDetailPayload>(`${apiBase}/${deploymentId}`)
  });

  if (releases.isLoading) return <div className="h-40 animate-pulse rounded-lg bg-panelAlt" />;
  if (releases.isError || !releases.data) return <p className="text-sm text-red-400">Failed to load deployment state.</p>;

  const runtimeState = releases.data.runtimeState ?? "UNKNOWN";

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

        {currentRelease ? (
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
          {activeOperation && (
            <div className="rounded border border-warning/30 bg-warning/10 p-2.5">
              <p className="font-medium text-amber-200">
                {activeOperation.type === "ROLLBACK" ? "Rollback" : "Deployment"} in progress
                {activeOperation.actorEmail ? ` — ${activeOperation.actorEmail}` : ""}
              </p>
              <p className="mt-0.5 text-xs text-muted">New deployments are blocked while this operation is active.</p>
            </div>
          )}
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => router.push(editHref)}>
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
          <Button size="sm" variant="secondary" onClick={() => router.push(editHref)}>
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
          apiBase={apiBase}
          onRollback={() => setRollbackOpen(true)}
          emptyState="This managed workload has not been deployed yet."
        />
      </section>

      {rollbackOpen && (
        <RollbackFlow
          deploymentId={deploymentId}
          apiBase={apiBase}
          onDone={() => setRollbackOpen(false)}
        />
      )}
    </div>
  );
}
