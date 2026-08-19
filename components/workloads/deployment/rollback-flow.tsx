"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch, isApiError } from "@/lib/fetcher";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PlanView } from "./plan-view";
import { OperationProgress } from "./operation-progress";
import { OperationResultView } from "./operation-result-view";
import { deploymentErrorMessage } from "./labels";
import type { DeploymentOperationPayload, DeploymentPlanPayload, RollbackTargetPayload } from "./types";

/**
 * Rollback flow — uses ONLY the qualified public contract:
 *   1. GET /rollback-target (previous healthy release's revision)
 *   2. POST /plan {revisionId} (authoritative plan + planHash)
 *   3. POST /rollback {revisionId, planHash} (explicit confirm)
 *   4. poll operation → new release
 * Historical secret values are never restored; the UI says so explicitly.
 */
export function RollbackFlow({
  deploymentId,
  apiBase = "/api/admin/deployments",
  onDone
}: {
  deploymentId: string;
  apiBase?: string;
  onDone: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [plan, setPlan] = useState<DeploymentPlanPayload | null>(null);
  const [opId, setOpId] = useState<string | null>(null);
  const [op, setOp] = useState<DeploymentOperationPayload | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);

  const target = useQuery({
    queryKey: ["rollback-target", apiBase, deploymentId],
    queryFn: () => apiFetch<RollbackTargetPayload>(`${apiBase}/${deploymentId}/rollback-target`),
    refetchOnWindowFocus: false
  });

  const generatePlan = async () => {
    if (!target.data) return;
    setBusy(true);
    setStale(false);
    try {
      const p = await apiFetch<DeploymentPlanPayload>(`${apiBase}/${deploymentId}/plan`, {
        method: "POST",
        body: JSON.stringify({ revisionId: target.data.revisionId })
      });
      setPlan(p);
    } catch (e) {
      toast.error(deploymentErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const rollback = useMutation({
    mutationFn: async () => {
      if (!target.data || !plan) return;
      const res = await apiFetch<{ operationId: string }>(`${apiBase}/${deploymentId}/rollback`, {
        method: "POST",
        body: JSON.stringify({ revisionId: target.data.revisionId, planHash: plan.planHash })
      });
      setOpId(res.operationId);
    },
    onError: (e) => {
      if (isApiError(e) && e.code === "PLAN_STALE") {
        setStale(true);
        setPlan(null);
        toast.error("The rollback plan is out of date. Generate a fresh plan.");
      } else {
        toast.error(deploymentErrorMessage(e));
      }
    }
  });

  const handleTerminal = (final: DeploymentOperationPayload) => {
    setOp(final);
    void queryClient.invalidateQueries({ queryKey: ["deployment-releases", apiBase, deploymentId] });
    void queryClient.invalidateQueries({ queryKey: ["workload"] });
    void queryClient.invalidateQueries({ queryKey: ["client-workloads"] });
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
      <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-border bg-panel p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Rollback</h2>
          <button type="button" onClick={onDone} className="text-muted hover:text-text" aria-label="Close">
            ✕
          </button>
        </div>

        {target.isLoading && <p className="text-sm text-muted">Resolving the rollback target…</p>}
        {target.isError && <p className="text-sm text-red-400">Could not resolve a rollback target. {deploymentErrorMessage(target.error)}</p>}

        {target.data && !opId && (
          <div className="space-y-4">
            <div className="rounded-lg border border-border bg-panelAlt p-4 text-sm">
              <p className="font-medium">Rollback target</p>
              <p className="mt-1 text-muted">
                <Badge variant="default">Revision {target.data.revisionNumber}</Badge>
                <span className="ml-2">the configuration of the last healthy release.</span>
              </p>
              <p className="mt-2 rounded border border-warning/30 bg-warning/10 p-2 text-amber-200">
                Rollback restores the <span className="font-medium">configuration</span> from Revision {target.data.revisionNumber}. Secrets will
                use their <span className="font-medium">current versions</span> — historical secret values are not restored. Persistent volumes
                and networks are preserved.
              </p>
            </div>

            {!plan && (
              <div className="flex items-center gap-2">
                <Button onClick={() => void generatePlan()} disabled={busy}>
                  {busy ? "Generating plan…" : "Generate rollback plan"}
                </Button>
                {stale && <span className="text-sm text-amber-300">The previous plan is no longer valid.</span>}
              </div>
            )}

            {plan && (
              <PlanView
                plan={plan}
                confirmLabel="Confirm rollback"
                confirmTone="warning"
                busy={rollback.isPending}
                note="Rolling back creates a NEW release using this revision — the previous release is never reactivated."
                onConfirm={() => rollback.mutate()}
              />
            )}
          </div>
        )}

        {opId && !op && <OperationProgress deploymentId={deploymentId} operationId={opId} apiBase={apiBase} onTerminal={handleTerminal} />}

        {op && (
          <OperationResultView
            op={op}
            onDone={() => {
              void queryClient.invalidateQueries({ queryKey: ["workload"] });
              void queryClient.invalidateQueries({ queryKey: ["client-workloads"] });
              onDone();
            }}
          />
        )}
      </div>
    </div>
  );
}
