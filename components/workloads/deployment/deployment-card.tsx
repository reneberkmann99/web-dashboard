"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { timeAgo } from "@/lib/format";
import type { WorkloadDeploymentStatus } from "./types";

/**
 * Managed-deployment card for the workload Overview. The wording is
 * deliberate: a degraded release is "configuration applied, health
 * verification failed" — never "deployment failed, nothing changed".
 */
export function DeploymentCard({
  deployment,
  workloadId,
  onGoToDeployments,
  onRollback
}: {
  deployment: NonNullable<WorkloadDeploymentStatus>;
  workloadId: string;
  onGoToDeployments: () => void;
  onRollback: () => void;
}): React.JSX.Element {
  const current = deployment.currentRelease;
  const lastHealthy = deployment.lastHealthyRelease;
  const runtimeState = deployment.runtimeState ?? "UNKNOWN";

  const healthVariant =
    runtimeState === "CONVERGED"
      ? "success"
      : runtimeState === "DEGRADED"
        ? "warning"
        : runtimeState === "DRIFTED"
          ? "danger"
          : "default";

  const runtimeLabel =
    runtimeState === "CONVERGED"
      ? "Runtime converged"
      : runtimeState === "DEGRADED"
        ? "Runtime is running the new configuration, but health verification failed"
        : runtimeState === "DRIFTED"
          ? "Runtime differs from the expected deployment state"
          : "Runtime state unknown";

  return (
    <div className="rounded-lg border border-border bg-panel p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Managed deployment</h2>
        <Badge variant={healthVariant}>{runtimeState === "CONVERGED" ? "Healthy" : runtimeState === "DEGRADED" ? "Degraded" : runtimeState}</Badge>
      </div>

      {!current ? (
        <p className="text-sm text-muted">This managed workload has not been deployed yet.</p>
      ) : (
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-xs uppercase text-muted">Revision</dt>
            <dd className="font-medium">{current.revisionNumber}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-muted">Release</dt>
            <dd className="font-medium">#{current.displayNumber ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-muted">Deployed</dt>
            <dd>{current.appliedAt ? timeAgo(current.appliedAt) : "—"}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-muted">By</dt>
            <dd className="truncate">{current.actorEmail ?? "—"}</dd>
          </div>
        </dl>
      )}

      {current && (
        <p className={`mt-2 text-sm ${runtimeState === "DEGRADED" ? "text-amber-300" : runtimeState === "DRIFTED" ? "text-red-300" : "text-muted"}`}>
          {runtimeLabel}
        </p>
      )}

      {deployment.activeOperation && (
        <div className="mt-3 rounded border border-warning/30 bg-warning/10 p-2.5 text-sm">
          <p className="font-medium text-amber-200">
            {deployment.activeOperation.type === "ROLLBACK" ? "Rollback" : "Deployment"} in progress
            {deployment.activeOperation.actorEmail ? ` — started by ${deployment.activeOperation.actorEmail}` : ""}
          </p>
          <p className="mt-0.5 text-xs text-muted">Another deployment cannot be submitted while this operation is active.</p>
          <Button size="sm" variant="secondary" className="mt-2" onClick={onGoToDeployments}>
            View operation
          </Button>
        </div>
      )}

      {runtimeState === "DEGRADED" && lastHealthy && (
        <div className="mt-3 rounded border border-border bg-panelAlt p-2.5 text-sm">
          <p className="text-xs uppercase text-muted">Last healthy</p>
          <p>
            Release #{lastHealthy.displayNumber ?? "—"} · Revision {lastHealthy.revisionNumber}
          </p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="warning" onClick={onRollback}>
              Rollback
            </Button>
          </div>
        </div>
      )}

      <div className="mt-4">
        <Button size="sm" variant="secondary" onClick={onGoToDeployments}>
          View deployment
        </Button>
      </div>
    </div>
  );
}
