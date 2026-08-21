"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch, isApiError } from "@/lib/fetcher";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { TabBar } from "@/components/ui/tab-bar";
import { PlanView } from "./plan-view";
import { OperationProgress } from "./operation-progress";
import { OperationResultView } from "./operation-result-view";
import { deploymentErrorMessage } from "./labels";
import { diffLines } from "./diff";
import { PageHeader } from "@/components/ui/page-header";
import { WorkloadFormEditor } from "./form/workload-form";
import { StructuredDiffView } from "./form/structured-diff-view";
import { useUnsavedGuard } from "./form/use-unsaved-guard";
import { parseComposeToForm } from "@/lib/compose-form/parse";
import { serializeForm } from "@/lib/compose-form/serialize";
import { validateComposeForm, hasBlockingIssues } from "@/lib/compose-form/validate";
import { diffComposeSources } from "@/lib/compose-form/diff";
import type { ComposeForm } from "@/lib/compose-form/model";
import type {
  DeploymentOperationPayload,
  DeploymentPlanPayload,
  ReleasesListPayload,
  RevisionDetailPayload,
  SecretListItem,
  ValidateResultPayload
} from "./types";

type Step = "edit" | "review" | "plan" | "progress" | "done";

const EDITOR_TABS = ["Form", "Compose source"] as const;
type EditorTab = (typeof EDITOR_TABS)[number];

export type EditorActiveOperation = {
  id: string;
  type: string;
  state: string;
  phase: string | null;
  actorEmail: string | null;
  startedAt: string | null;
} | null;

/**
 * Compose configuration editor — the managed deployment workflow:
 *   Edit → Validate → Save as revision (no Docker mutation) → Review diff →
 *   Generate plan → Review plan → Confirm → Deploy → Operation progress.
 *
 * The Form tab is a structured projection of the SAME compose document that the
 * Compose source tab edits: form changes are serialized back to YAML and pushed
 * through the identical revisions/plan/deploy endpoints. There is no second
 * deployment engine and no "simple workload" backend path.
 *
 * Scope-agnostic: works for both admin (`/api/admin/deployments`) and client
 * (`/api/client/deployments`) tenants via `apiBase`/`validateUrl`.
 */
export function DeploymentEditor({
  workloadName,
  deploymentId,
  nodeId,
  activeOperation,
  apiBase = "/api/admin/deployments",
  validateUrl = "/api/admin/deployments/validate",
  backHref,
  rollbackHref,
  canEdit = true,
  canDeploy = true
}: {
  workloadName: string;
  deploymentId: string;
  nodeId: string;
  activeOperation: EditorActiveOperation;
  apiBase?: string;
  validateUrl?: string;
  backHref: string;
  rollbackHref: string;
  canEdit?: boolean;
  canDeploy?: boolean;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const router = useRouter();

  const [step, setStep] = useState<Step>("edit");
  const [tab, setTab] = useState<EditorTab>("Form");
  const [compose, setCompose] = useState<string | null>(null);
  const [form, setForm] = useState<ComposeForm | null>(null);
  const [baseCompose, setBaseCompose] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [validation, setValidation] = useState<ValidateResultPayload | null>(null);
  const [validating, setValidating] = useState(false);
  const [ackHighRisk, setAckHighRisk] = useState(false);
  const [savedRevision, setSavedRevision] = useState<{ revisionId: string; revisionNumber: number } | null>(null);
  const [plan, setPlan] = useState<DeploymentPlanPayload | null>(null);
  const [opId, setOpId] = useState<string | null>(null);
  const [op, setOp] = useState<DeploymentOperationPayload | null>(null);
  const [stale, setStale] = useState(false);
  const [secretDialog, setSecretDialog] = useState<
    | { mode: "create"; key: string; value: string }
    | { mode: "rotate"; key: string; secretId: string; value: string }
    | null
  >(null);

  const { guardedNavigate, dialog: unsavedDialog } = useUnsavedGuard(dirty && step === "edit");

  // Current release → active revision (editor base + diff source).
  const releases = useQuery({
    queryKey: ["deployment-releases", apiBase, deploymentId],
    queryFn: () => apiFetch<ReleasesListPayload>(`${apiBase}/${deploymentId}/releases?limit=100`)
  });
  const currentRelease = releases.data?.data.find((r) => r.isCurrent) ?? null;
  const noReleaseYet = !releases.isLoading && !releases.isError && !currentRelease;

  const currentRevision = useQuery({
    queryKey: ["deployment-revision", apiBase, deploymentId, currentRelease?.revisionId],
    queryFn: () => apiFetch<RevisionDetailPayload>(`${apiBase}/${deploymentId}/revisions/${currentRelease!.revisionId}`),
    enabled: Boolean(currentRelease)
  });

  // Before the first deploy there is no release, so there is no current-release
  // revision to seed from. Fall back to the latest saved revision.
  const latestRevision = useQuery({
    queryKey: ["deployment-latest-revision", apiBase, deploymentId],
    queryFn: async () => {
      const list = await apiFetch<{ data: Array<{ id: string; revisionNumber: number }>; total: number }>(
        `${apiBase}/${deploymentId}/revisions`
      );
      const latest = list.data[0];
      if (!latest) return null;
      return apiFetch<RevisionDetailPayload>(`${apiBase}/${deploymentId}/revisions/${latest.id}`);
    },
    enabled: noReleaseYet
  });

  const secrets = useQuery({
    queryKey: ["deployment-secrets", apiBase, deploymentId],
    queryFn: () => apiFetch<{ data: SecretListItem[]; total: number }>(`${apiBase}/${deploymentId}/secrets`)
  });

  const baseRevision = currentRevision.data ?? latestRevision.data ?? undefined;
  const secretRefs = useMemo(() => baseRevision?.secretReferences ?? [], [baseRevision]);

  // Seed the editor once the active revision loads (release path) or, before the
  // first deploy, from the latest saved revision (fallback path).
  useEffect(() => {
    if (compose !== null) return;
    let seed: string | null = null;
    if (currentRevision.data) seed = currentRevision.data.composeSource;
    else if (noReleaseYet && latestRevision.data !== undefined) seed = latestRevision.data?.composeSource ?? "";
    if (seed === null) return;
    setCompose(seed);
    setBaseCompose(seed);
    setForm(parseComposeToForm(seed, secretRefs));
  }, [compose, currentRevision.data, noReleaseYet, latestRevision.data, secretRefs]);

  const applyForm = (next: ComposeForm): void => {
    setForm(next);
    setCompose(serializeForm(next));
    setDirty(true);
    setValidation(null);
  };

  const applyCompose = (next: string): void => {
    setCompose(next);
    setDirty(true);
    setValidation(null);
  };

  const switchTab = (next: EditorTab): void => {
    if (next === "Form" && compose !== null) {
      const parsed = parseComposeToForm(compose, secretRefs);
      if (parsed.parseError) {
        toast.error(`Compose source cannot be shown as a form yet: ${parsed.parseError}`);
        return;
      }
      setForm(parsed);
    }
    setTab(next);
  };

  const formIssues = useMemo(() => (form ? validateComposeForm(form) : []), [form]);
  const formBlocked = hasBlockingIssues(formIssues);

  const yamlDiff = useMemo(() => {
    if (baseCompose === null || compose === null || compose === baseCompose) return null;
    return diffLines(baseCompose, compose);
  }, [baseCompose, compose]);

  const structuredDiff = useMemo(() => {
    if (baseCompose === null || compose === null) return null;
    return diffComposeSources(baseCompose, compose, secretRefs);
  }, [baseCompose, compose, secretRefs]);

  const runValidate = async (): Promise<void> => {
    if (compose === null) return;
    setValidating(true);
    try {
      const res = await apiFetch<ValidateResultPayload>(validateUrl, {
        method: "POST",
        body: JSON.stringify({
          nodeId,
          compose,
          environment: baseRevision?.environmentSnapshot ?? {},
          secretReferences: secretRefs
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
        `${apiBase}/${deploymentId}/revisions`,
        {
          method: "POST",
          body: JSON.stringify({
            compose,
            environment: baseRevision?.environmentSnapshot ?? {},
            secretReferences: secretRefs,
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
      const p = await apiFetch<DeploymentPlanPayload>(`${apiBase}/${deploymentId}/plan`, {
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
      const res = await apiFetch<{ operationId: string }>(`${apiBase}/${deploymentId}/deploy`, {
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

  // --- Secret helpers (convert plaintext env → secret, rotate existing) -----
  const submitSecret = useMutation({
    mutationFn: async () => {
      if (!secretDialog) return;
      if (secretDialog.mode === "create") {
        await apiFetch(`${apiBase}/${deploymentId}/secrets`, {
          method: "POST",
          body: JSON.stringify({ key: secretDialog.key, value: secretDialog.value })
        });
      } else {
        await apiFetch(`${apiBase}/${deploymentId}/secrets/${secretDialog.secretId}/versions`, {
          method: "POST",
          body: JSON.stringify({ value: secretDialog.value })
        });
      }
    },
    onSuccess: () => {
      const dlg = secretDialog;
      setSecretDialog(null);
      void queryClient.invalidateQueries({ queryKey: ["deployment-secrets", apiBase, deploymentId] });
      if (dlg?.mode === "create" && form) {
        // Replace the plaintext value with a ${KEY} reference in every service.
        const next: ComposeForm = {
          ...form,
          services: form.services.map((s) => ({
            ...s,
            environment: s.environment.map((e) =>
              e.key.trim() === dlg.key ? { ...e, value: `\${${dlg.key}}`, isSecret: true } : e
            )
          }))
        };
        applyForm(next);
        toast.success(`${dlg.key} is now a Noderaft-managed secret. Save a revision and deploy to apply it.`);
      } else {
        toast.success("Secret rotated. Generate a plan and deploy to roll the new version out.");
      }
    },
    onError: (e) => toast.error(deploymentErrorMessage(e))
  });

  const title = `Edit configuration — ${workloadName}`;
  const editingDisabled = !canEdit;

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      {unsavedDialog}
      <PageHeader
        eyebrow="Managed deployment"
        title={title}
        back={
          <button
            type="button"
            onClick={() => guardedNavigate(backHref)}
            className="mb-2 text-sm text-brand hover:text-brand-hover"
          >
            ← {workloadName}
          </button>
        }
        description={
          <span>
            {savedRevision
              ? `Working on revision ${savedRevision.revisionNumber}`
              : currentRelease
                ? `Current runtime revision: ${currentRelease.revisionNumber}`
                : "No deployment yet"}
          </span>
        }
        actions={
          step !== "progress" ? (
            <>
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
            </>
          ) : undefined
        }
      />

      {activeOperation && step !== "progress" && (
        <div className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning-foreground">
          A {activeOperation.type.toLowerCase()} operation is already in progress on this workload
          {activeOperation.actorEmail ? ` (started by ${activeOperation.actorEmail})` : ""}. You can edit and save
          configuration, but another deployment cannot be submitted until it completes.
        </div>
      )}

      {editingDisabled && (
        <div className="rounded-lg border border-border bg-panel p-3 text-sm text-muted">
          You have read-only access to this workload's configuration.
        </div>
      )}

      {/* EDIT */}
      {step === "edit" &&
        compose === null &&
        (releases.isLoading || (noReleaseYet && latestRevision.isLoading) || (currentRelease && currentRevision.isLoading)) && (
          <div className="h-40 animate-pulse rounded-lg bg-panelAlt" />
        )}

      {step === "edit" &&
        compose === null &&
        !releases.isLoading &&
        (releases.isError || (noReleaseYet && latestRevision.isError) || (currentRelease && currentRevision.isError)) && (
          <div className="space-y-3">
            <div className="rounded-lg border border-critical/30 bg-critical/10 p-4 text-sm text-critical-foreground">
              Failed to load the current configuration.
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  void releases.refetch();
                  void currentRevision.refetch();
                  void latestRevision.refetch();
                }}
              >
                Retry
              </Button>
              <Button size="sm" variant="secondary" onClick={() => router.push(backHref)}>
                Back to workload
              </Button>
            </div>
          </div>
        )}

      {step === "edit" && compose !== null && (
        <div className="space-y-4">
          <TabBar tabs={EDITOR_TABS} active={tab} onChange={switchTab} idPrefix="deployment-editor" />

          <div id={`deployment-editor-panel-${tab}`} role="tabpanel" aria-labelledby={`deployment-editor-tab-${tab}`}>
            {tab === "Form" && form && (
              <WorkloadFormEditor
                form={form}
                issues={formIssues}
                onChange={applyForm}
                readOnly={editingDisabled}
                secretKeys={secretRefs}
                onConvertToSecret={(key, value) => setSecretDialog({ mode: "create", key, value })}
                onRotateSecret={(key) => {
                  const secret = secrets.data?.data.find((s) => s.key === key);
                  if (!secret) {
                    toast.error(`No Noderaft-managed secret named ${key} exists for this workload.`);
                    return;
                  }
                  setSecretDialog({ mode: "rotate", key, secretId: secret.id, value: "" });
                }}
                onRemoveService={
                  editingDisabled
                    ? undefined
                    : (serviceName) => {
                        const next: ComposeForm = {
                          ...form,
                          services: form.services.filter((s) => s.name.trim() !== serviceName)
                        };
                        applyForm(next);
                        toast.success(
                          `Service "${serviceName}" removed from the definition. Save a revision, review the plan, then deploy to remove its container. Named volumes are preserved.`
                        );
                      }
                }
              />
            )}

            {tab === "Compose source" && (
              <div className="space-y-2">
                <p className="text-xs text-text-subtle">
                  Advanced: edit the compose document directly. Switching back to the Form tab re-reads this source.
                </p>
                <textarea
                  value={compose}
                  readOnly={editingDisabled}
                  onChange={(e) => applyCompose(e.target.value)}
                  spellCheck={false}
                  className="h-[420px] w-full resize-y rounded-lg border border-border bg-panelAlt p-4 font-mono text-xs leading-relaxed text-text outline-none focus:border-accent"
                  aria-label="Compose YAML"
                />
              </div>
            )}
          </div>

          {tab === "Form" && formIssues.length > 0 && (
            <div className="rounded-lg border border-border bg-panel p-4">
              <p className="mb-2 text-sm font-semibold">
                {formBlocked ? (
                  <Badge variant="danger">{formIssues.filter((i) => i.severity === "error").length} problems</Badge>
                ) : (
                  <Badge variant="warning">{formIssues.length} notes</Badge>
                )}
              </p>
              <ul className="space-y-1 text-sm">
                {formIssues.map((i, idx) => (
                  <li key={`${i.path}-${idx}`} className={i.severity === "error" ? "text-critical-foreground" : "text-warning-foreground"}>
                    {i.serviceName ? `${i.serviceName}: ` : ""}
                    {i.message}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-text-subtle">
                These checks are a convenience only — Noderaft always re-validates on the node before anything is saved.
              </p>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() => void runValidate()}
              disabled={validating || editingDisabled || compose.trim().length === 0 || (tab === "Form" && formBlocked)}
            >
              {validating ? "Validating…" : "Validate"}
            </Button>
            <Button type="button" variant="secondary" onClick={() => guardedNavigate(backHref)}>
              Cancel
            </Button>
            {dirty && <span className="text-xs text-warning-foreground">Unsaved changes</span>}
          </div>

          {validation && (
            <div className="rounded-lg border border-border bg-panel p-4">
              <p className="mb-2 text-sm font-semibold">
                Validation {validation.valid ? <Badge variant="success">valid</Badge> : <Badge variant="danger">invalid</Badge>}
              </p>
              {validation.composeErrors.map((err, i) => (
                <p key={i} className="break-words font-mono text-xs text-critical-foreground">
                  {err}
                </p>
              ))}
              {validation.blockedFindings.map((f) => (
                <p key={f.ruleId + f.message} className="text-sm text-critical-foreground">
                  BLOCKED — {f.message}
                </p>
              ))}
              {validation.highRiskFindings.map((f) => (
                <div key={f.fingerprint ?? f.ruleId + f.message} className="mt-1 text-sm text-warning-foreground">
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
      {step === "review" && savedRevision && (
        <div className="space-y-3">
          <div className="rounded-lg border border-border bg-panel p-4">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">
              Changes vs {currentRelease ? `revision ${currentRelease.revisionNumber}` : "last saved revision"}
            </h2>
            <p className="mb-3 text-xs text-muted">
              What you changed in the configuration — separately from what Noderaft will mutate at deploy time. Secret
              values are never shown.
            </p>

            {structuredDiff && <StructuredDiffView diff={structuredDiff} />}

            {yamlDiff && (
              <details className="mt-4">
                <summary className="cursor-pointer text-xs text-text-muted hover:text-text">Show raw compose diff</summary>
                <pre className="mt-2 max-h-96 overflow-auto rounded border border-border bg-panelAlt p-3 font-mono text-xs leading-relaxed">
                  {yamlDiff.map((line, i) => (
                    <div
                      key={i}
                      className={
                        line.type === "added"
                          ? "bg-success/10 text-success-foreground"
                          : line.type === "removed"
                            ? "bg-critical/10 text-critical-foreground"
                            : "text-muted"
                      }
                    >
                      <span className="mr-2 inline-block w-4 select-none text-right">
                        {line.type === "added" ? "+" : line.type === "removed" ? "−" : " "}
                      </span>
                      {line.text || " "}
                    </div>
                  ))}
                </pre>
              </details>
            )}

            {!yamlDiff && (
              <p className="text-sm text-muted">
                {currentRelease
                  ? "This configuration is identical to the current revision — no changes to review."
                  : "This is the first revision of this workload — there is no previous configuration to compare against."}
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <Button onClick={() => void generatePlan()} disabled={!canDeploy}>
              Generate deployment plan
            </Button>
            <Button variant="secondary" onClick={() => setStep("edit")}>
              Keep editing
            </Button>
          </div>
          {!canDeploy && (
            <p className="text-xs text-muted">Your role can save configuration revisions but not deploy them.</p>
          )}
        </div>
      )}

      {/* PLAN */}
      {step === "plan" && savedRevision && (
        <div className="space-y-3">
          {stale && (
            <div className="rounded-lg border border-warning/40 bg-warning/10 p-3">
              <p className="font-medium text-warning-foreground">Deployment plan is out of date</p>
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
      {step === "progress" && opId && (
        <OperationProgress
          deploymentId={deploymentId}
          operationId={opId}
          apiBase={apiBase}
          onTerminal={(final) => {
            setOp(final);
            setStep("done");
            void queryClient.invalidateQueries({ queryKey: ["workload"] });
            void queryClient.invalidateQueries({ queryKey: ["client-workloads"] });
            void queryClient.invalidateQueries({ queryKey: ["deployment-releases"] });
          }}
        />
      )}

      {/* DONE */}
      {step === "done" && op && (
        <OperationResultView op={op} onRollback={() => router.push(rollbackHref)} onDone={() => router.push(backHref)} />
      )}

      {secretDialog && (
        <Modal
          open
          onClose={() => setSecretDialog(null)}
          title={secretDialog.mode === "create" ? `Convert ${secretDialog.key} to a secret` : `Rotate ${secretDialog.key}`}
          size="sm"
          footer={
            <>
              <Button variant="secondary" onClick={() => setSecretDialog(null)} disabled={submitSecret.isPending}>
                Cancel
              </Button>
              <Button
                onClick={() => submitSecret.mutate()}
                disabled={submitSecret.isPending || secretDialog.value.trim().length === 0}
              >
                {submitSecret.isPending ? "Saving…" : secretDialog.mode === "create" ? "Create secret" : "Rotate"}
              </Button>
            </>
          }
        >
          <p className="mb-3 text-sm text-muted">
            {secretDialog.mode === "create"
              ? "The value is encrypted at rest and replaced in the configuration by a reference. It is never shown again, never written to audit logs, and never appears in a diff."
              : "A new secret version is created. Nothing is deployed until you review a plan and confirm."}
          </p>
          <Input
            type="password"
            autoComplete="new-password"
            aria-label="Secret value"
            value={secretDialog.value}
            onChange={(e) => setSecretDialog({ ...secretDialog, value: e.target.value })}
          />
        </Modal>
      )}
    </div>
  );
}
