"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { DeploymentOperationPayload, WorkloadDeploymentStatus } from "./types";

/**
 * Terminal operation result — with the DEGRADED nuance made explicit:
 * `FAILED + runtimeConverged` means the configuration IS running but health
 * verification failed. Never shown as a generic "deployment failed".
 */
export function OperationResultView({
  op,
  onRollback,
  onViewRelease,
  onDone
}: {
  op: DeploymentOperationPayload;
  onRollback?: () => void;
  onViewRelease?: (releaseId: string) => void;
  onDone?: () => void;
}): React.JSX.Element {
  const result = op.result ?? {};
  const degraded = op.state === "FAILED" && result.runtimeConverged === true;

  if (op.state === "SUCCEEDED") {
    return (
      <div className="rounded-lg border border-success/40 bg-success/10 p-4">
        <div className="mb-2 flex items-center gap-2">
          <Badge variant="success">Deployed</Badge>
          <h3 className="font-semibold">Deployment completed successfully</h3>
        </div>
        <p className="text-sm text-muted">
          The new configuration is running and all health checks passed.
          {result.releaseId ? " A new release was recorded." : ""}
        </p>
        <div className="mt-3 flex gap-2">
          {result.releaseId && (
            <Button size="sm" variant="secondary" onClick={() => onViewRelease?.(String(result.releaseId))}>
              View release
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={onDone}>
            Back to workload
          </Button>
        </div>
      </div>
    );
  }

  if (degraded) {
    return (
      <div className="rounded-lg border border-warning/40 bg-warning/10 p-4">
        <div className="mb-2 flex items-center gap-2">
          <Badge variant="warning">Deployment applied — health verification failed</Badge>
        </div>
        <p className="text-sm">
          <span className="font-medium">The new configuration is currently running.</span> HostPanel could not verify
          that all services became healthy before the verification deadline.
        </p>
        <p className="mt-2 text-sm text-muted">
          {result.releaseId ? (
            <>
              A degraded release was recorded. The previous healthy release remains the last known-good configuration.
            </>
          ) : (
            "No release was recorded."
          )}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {result.releaseId && (
            <Button size="sm" variant="secondary" onClick={() => onViewRelease?.(String(result.releaseId))}>
              View release
            </Button>
          )}
          {onRollback && (
            <Button size="sm" variant="warning" onClick={onRollback}>
              Rollback
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={onDone}>
            Inspect workload
          </Button>
        </div>
      </div>
    );
  }

  if (op.state === "CANCELLED") {
    return (
      <div className="rounded-lg border border-border bg-panel p-4">
        <Badge variant="default">Cancelled</Badge>
        <p className="mt-2 text-sm text-muted">The operation was cancelled. Runtime state was re-verified before completing.</p>
        <div className="mt-3">
          <Button size="sm" variant="secondary" onClick={onDone}>
            Back to workload
          </Button>
        </div>
      </div>
    );
  }

  // Plain FAILED without runtime convergence.
  return (
    <div className="rounded-lg border border-danger/40 bg-danger/10 p-4">
      <div className="mb-2 flex items-center gap-2">
        <Badge variant="danger">Deployment failed</Badge>
      </div>
      <p className="text-sm">
        The deployment did not complete. {op.error ? <span className="font-medium">{op.error}</span> : "No error detail was recorded."}
      </p>
      <p className="mt-2 text-sm text-muted">The workload was left running its previous configuration where possible.</p>
      <div className="mt-3">
        <Button size="sm" variant="secondary" onClick={onDone}>
          Back to workload
        </Button>
      </div>
    </div>
  );
}

export type { WorkloadDeploymentStatus };
