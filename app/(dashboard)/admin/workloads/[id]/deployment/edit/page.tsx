"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch, isApiError } from "@/lib/fetcher";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PlanView } from "@/components/workloads/deployment/plan-view";
import { OperationProgress } from "@/components/workloads/deployment/operation-progress";
import { OperationResultView } from "@/components/workloads/deployment/operation-result-view";
import { deploymentErrorMessage } from "@/components/workloads/deployment/labels";
import { diffLines } from "@/components/workloads/deployment/diff";
import type {
  DeploymentOperationPayload,
  DeploymentPlanPayload,
  ReleasesListPayload,
  RevisionDetailPayload,
  ValidateResultPayload,
  WorkloadDeploymentStatus
} from "@/components/workloads/deployment/types";

type Step = "edit" | "review" | "plan" | "progress" | "done";

/**
 * Compose configuration editor — the managed deployment workflow:
 *   Edit → Validate → Save as revision (no Docker mutation) → Review diff →
 *   Generate plan → Review plan → Confirm → Deploy → Operation progress.
 */
export default function DeploymentEditPage(): React.JSX.Element {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [step, setStep] = useState<Step>("edit");
  const [compose, setCompose] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [validation, setValidation] = useState<ValidateResultPayload | null>(null);
  const [validating, setValidating] = useState(false);
  const [ackHighRisk, setAckHighRisk] = useState(false);
  const [savedRevision, setSavedRevision] = useState<{ revisionId: string; revisionNumber: number } | null>(null);
  const [plan, setPlan] = useState<DeploymentPlanPayload | null>(null);
  const [opId, setOpId] = useState<string | null>(null);
  const [op, setOp] = useState<DeploymentOperationPayload | null>(null);
  const [stale, setStale] = useState(false);

  // Workload + deployment context.
  const workload = useQuery({
    queryKey: ["workload", params.id],
    queryFn: () =>
      apiFetch<{
        workload: { id: string; name: string; node: { id: string } };
        deployment: WorkloadDeploymentStatus;
      }>(`/api/admin/workloads/${params.id}`)
  });
  const deploymentId = workload.data?.deployment.deploymentId ?? null;
  const managed = workload.data?.deployment.managed ?? false;

  // Current release → active revision (editor base + diff source).
  const releases = useQuery({
    queryKey: ["deployment-releases", deploymentId],
    queryFn: () => apiFetch<ReleasesListPayload>(`/api/admin/deployments/${deploymentId}/releases?limit=100`),
    enabled: Boolean(deploymentId)
  });
  const currentRelease = releases.data?.data.find((r) => r.isCurrent) ?? null;

  const currentRevision = useQuery({
    queryKey: ["deployment-revision", deploymentId, currentRelease?.revisionId],
    queryFn: () => apiFetch<RevisionDetailPayload>(`/api/admin/deployments/${deploymentId}/revisions/${currentRelease!.revisionId}`),
    enabled: Boolean(deploymentId && currentRelease)
  });

  // Seed the editor once the active revision loads.
  useEffect(() => {
    if (compose === null && currentRevision.data) {
      setCompose(currentRevision.data.composeSource);
    }
  }, [compose, currentRevision.data]);

  // Unsaved-change protection.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const baseRevision = currentRevision.data;
  const diff = useMemo(() => {
    if (!baseRevision || compose === null || compose === baseRevision.composeSource) return null;
    return diffLines(baseRevision.composeSource, compose);
  }, [baseRevision, compose]);

  const runValidate = async (): Promise<void> => {
    if (!workload.data || compose === null) return;
    setValidating(true);
    try {
      const res = await apiFetch<ValidateResultPayload>(`/api/admin/deployments/validate`, {
        method: "POST",
        body: JSON.stringify({
          nodeId: workload.data.workload.node.id,
          compose,
          environment: baseRevision?.environmentSnapshot ?? {},
          secretReferences: baseRevision?.secretReferences ?? []
        })
      });
      setValidation(res);
    } catch (e) {
      toast.error(deploymentErrorMessage(e));
      setValidation(null);
    } finally {
      setValidating(false);
    }
  };

  const saveRevision = useMutation({
    mutationFn: async () => {
      if (!validation) throw new Error("validation missing");
      const res = await apiFetch<{ revisionId: string; revisionNumber: number; deduplicated: boolean }>(
        `/api/admin/deployments/${deploymentId}/revisions`,
        {
          method: "POST",
          body: JSON.stringify({
            compose,
            environment: baseRevision?.environmentSnapshot ?? {},
            secretReferences: baseRevision?.secretReferences ?? [],
            acknowledgedFindings: ackHighRisk ? (validation.highRiskFindings ?? []).map((f) => f.fingerprint as string) : []
          })
        }
      );
      setSavedRevision({ revisionId: res.revisionId, revisionNumber: res.revisionNumber });
      setDirty(false);
      return res;
    },
    onSuccess: (res) => {
      toast.success(`Saved as revision ${res.revisionNumber} — nothing has been deployed yet.`);
      setStep("review");
    },
    onError: (e) => toast.error(deploymentErrorMessage(e))
  });

  const generatePlan = async (): Promise<void> => {
    if (!savedRevision) return;
    setStale(false);
    try {
      const p = await apiFetch<DeploymentPlanPayload>(`/api/admin/deployments/${deploymentId}/plan`, {
        method: "POST",
        body: JSON.stringify({ revisionId: savedRevision.revisionId })
      });
      setPlan(p);
      setStep("plan");
    } catch (e) {
      toast.error(deploymentErrorMessage(e));
    }
  };

  const deploy = useMutation({
    mutationFn: async () => {
      if (!savedRevision || !plan) return;
      const res = await apiFetch<{ operationId: string }>(`/api/admin/deployments/${deploymentId}/deploy`, {
        method: "POST",
        body: JSON.stringify({ revisionId: savedRevision.revisionId, planHash: plan.planHash })
      });
      setOpId(res.operationId);
      setStep("progress");
    },
    onError: (e) => {
      if (isApiError(e) && e.code === "PLAN_STALE") {
        setStale(true);
        setPlan(null);
        toast.error("The deployment plan is out of date. Generate a fresh plan before deploying.");
      } else {
        toast.error(deploymentErrorMessage(e));
      }
    }
  });

  if (workload.isLoading) return <div className="h-40 animate-pulse rounded-lg bg-panelAlt" />;
  if (workload.isError || !workload.data) return <p className="text-sm text-red-400">Failed to load workload.</p>;
  if (!managed || !deploymentId) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted">This workload is not managed by HostPanel and has no deployment lifecycle.</p>
        <Button size="sm" variant="secondary" onClick={() => router.push(`/admin/workloads/${params.id}`)}>
          ← Back to workload
        </Button>
      </div>
    );
  }

  const title = `Edit configuration — ${workload.data.workload.name}`;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <button type="button" onClick={() => router.push(`/admin/workloads/${params.id}`)} className="mb-1 text-sm text-accent hover:underline">
            ← {workload.data.workload.name}
          </button>
          <h1 className="text-2xl font-semibold">{title}</h1>
          <p className="text-sm text-muted">
            {savedRevision
              ? `Working on revision ${savedRevision.revisionNumber}`
              : currentRelease
                ? `Current runtime revision: ${currentRelease.revisionNumber}`
                : "No deployment yet"}
          </p>
        </div>
        {step !== "progress" && (
          <div className="flex gap-2">
            {step === "review" && (
              <Button size="sm" variant="secondary" onClick={() => setStep("edit")}>
                Back to editor
              </Button>
            )}
            {step === "plan" && (
              <Button size="sm" variant="secondary" onClick={() => setStep("review")}>
                Back
              </Button>
            )}
          </div>
        )}
      </div>

      {workload.data.deployment.activeOperation && step !== "progress" && (
        <div className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-amber-200">
          A {workload.data.deployment.activeOperation.type.toLowerCase()} operation is already in progress on this workload
          {workload.data.deployment.activeOperation.actorEmail ? ` (started by ${workload.data.deployment.activeOperation.actorEmail})` : ""}. You
          can edit and save configuration, but another deployment cannot be submitted until it completes.
        </div>
      )}

      {/* EDIT */}
      {step === "edit" && compose !== null && (
        <div className="space-y-3">
          {currentRevision.isLoading && <p className="text-sm text-muted">Loading current configuration…</p>}
          <textarea
            value={compose}
            onChange={(e) => {
              setCompose(e.target.value);
              setDirty(true);
              setValidation(null);
            }}
            spellCheck={false}
            className="h-[420px] w-full resize-y rounded-lg border border-border bg-panelAlt p-4 font-mono text-xs leading-relaxed text-text outline-none focus:border-accent"
            aria-label="Compose YAML"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => void runValidate()} disabled={validating || compose.trim().length === 0}>
              {validating ? "Validating…" : "Validate"}
            </Button>
            <Button variant="secondary" onClick={() => router.push(`/admin/workloads/${params.id}`)}>
              Cancel
            </Button>
            {dirty && <span className="text-xs text-amber-300">Unsaved changes</span>}
          </div>

          {validation && (
            <div className="rounded-lg border border-border bg-panel p-4">
              <p className="mb-2 text-sm font-semibold">
                Validation {validation.valid ? <Badge variant="success">valid</Badge> : <Badge variant="danger">invalid</Badge>}
              </p>
              {validation.composeErrors.map((err, i) => (
                <p key={i} className="break-words font-mono text-xs text-red-300">
                  {err}
                </p>
              ))}
              {validation.blockedFindings.map((f) => (
                <p key={f.ruleId + f.message} className="text-sm text-red-300">
                  BLOCKED — {f.message}
                </p>
              ))}
              {validation.highRiskFindings.map((f) => (
                <div key={f.fingerprint ?? f.ruleId + f.message} className="mt-1 text-sm text-amber-300">
                  High risk — {f.message}
                </div>
              ))}
              {validation.findings.filter((f) => f.severity === "INFO" || f.severity === "WARNING").length > 0 && (
                <p className="mt-1 text-xs text-muted">
                  {validation.findings.filter((f) => f.severity === "INFO" || f.severity === "WARNING").length} informational findings.
                </p>
              )}
              {validation.valid && validation.highRiskFindings.length > 0 && (
                <label className="mt-3 flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={ackHighRisk} onChange={(e) => setAckHighRisk(e.target.checked)} />
                  I acknowledge these high-risk findings and want to save this configuration anyway.
                </label>
              )}
              {validation.valid && (
                <div className="mt-3">
                  <Button
                    size="sm"
                    onClick={() => saveRevision.mutate()}
                    disabled={saveRevision.isPending || (validation.highRiskFindings.length > 0 && !ackHighRisk)}
                  >
                    {saveRevision.isPending ? "Saving…" : "Save as new revision"}
                  </Button>
                  <p className="mt-1.5 text-xs text-muted">Saving creates a new immutable revision. It does NOT deploy anything.</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* REVIEW (diff) */}
      {step === "review" && savedRevision && diff && (
        <div className="space-y-3">
          <div className="rounded-lg border border-border bg-panel p-4">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">
              Changes vs revision {currentRelease?.revisionNumber ?? "—"}
            </h2>
            <p className="mb-2 text-xs text-muted">What you changed in the configuration — separately from what HostPanel will mutate at deploy time.</p>
            <pre className="max-h-96 overflow-auto rounded border border-border bg-panelAlt p-3 font-mono text-xs leading-relaxed">
              {diff.map((line, i) => (
                <div
                  key={i}
                  className={
                    line.type === "added"
                      ? "bg-success/10 text-green-300"
                      : line.type === "removed"
                        ? "bg-danger/10 text-red-300"
                        : "text-muted"
                  }
                >
                  <span className="mr-2 inline-block w-4 select-none text-right">{line.type === "added" ? "+" : line.type === "removed" ? "−" : " "}</span>
                  {line.text || " "}
                </div>
              ))}
            </pre>
          </div>
          <div className="flex gap-2">
            <Button onClick={() => void generatePlan()}>Generate deployment plan</Button>
            <Button variant="secondary" onClick={() => setStep("edit")}>
              Keep editing
            </Button>
          </div>
        </div>
      )}

      {step === "review" && savedRevision && !diff && (
        <div className="rounded-lg border border-border bg-panel p-4 text-sm">
          <p className="text-muted">This configuration is identical to the current revision — no changes to review.</p>
          <div className="mt-3 flex gap-2">
            <Button onClick={() => void generatePlan()}>Generate deployment plan anyway</Button>
            <Button variant="secondary" onClick={() => setStep("edit")}>
              Keep editing
            </Button>
          </div>
        </div>
      )}

      {/* PLAN */}
      {step === "plan" && savedRevision && (
        <div className="space-y-3">
          {stale && (
            <div className="rounded-lg border border-warning/40 bg-warning/10 p-3">
              <p className="font-medium text-amber-200">Deployment plan is out of date</p>
              <p className="mt-1 text-sm text-muted">
                The workload or its secrets changed after this plan was generated. Review a fresh plan before deploying.
              </p>
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="warning" onClick={() => void generatePlan()}>
                  Generate new plan
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setStep("review")}>
                  Back
                </Button>
              </div>
            </div>
          )}
          {plan && (
            <PlanView
              plan={plan}
              confirmLabel={`Deploy revision ${savedRevision.revisionNumber}`}
              confirmTone="default"
              busy={deploy.isPending}
              onConfirm={() => deploy.mutate()}
            />
          )}
        </div>
      )}

      {/* PROGRESS */}
      {step === "progress" && opId && deploymentId && (
        <OperationProgress
          deploymentId={deploymentId}
          operationId={opId}
          onTerminal={(final) => {
            setOp(final);
            setStep("done");
            void queryClient.invalidateQueries({ queryKey: ["workload", params.id] });
            void queryClient.invalidateQueries({ queryKey: ["deployment-releases", deploymentId] });
          }}
        />
      )}

      {/* DONE */}
      {step === "done" && op && (
        <OperationResultView
          op={op}
          deployment={{ deploymentId, workloadId: params.id }}
          onRollback={() => router.push(`/admin/workloads/${params.id}?rollback=1`)}
          onDone={() => router.push(`/admin/workloads/${params.id}`)}
        />
      )}
    </div>
  );
}
