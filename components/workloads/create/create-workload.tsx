"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch, isApiError } from "@/lib/fetcher";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { TabBar } from "@/components/ui/tab-bar";
import { WorkloadFormEditor } from "@/components/workloads/deployment/form/workload-form";
import { PlanView } from "@/components/workloads/deployment/plan-view";
import { OperationProgress } from "@/components/workloads/deployment/operation-progress";
import { OperationResultView } from "@/components/workloads/deployment/operation-result-view";
import { deploymentErrorMessage } from "@/components/workloads/deployment/labels";
import { parseComposeToForm } from "@/lib/compose-form/parse";
import { serializeForm } from "@/lib/compose-form/serialize";
import { validateComposeForm, hasBlockingIssues } from "@/lib/compose-form/validate";
import { emptyService, type ComposeForm } from "@/lib/compose-form/model";
import { extractSecretReferences } from "@/lib/compose-form/create-payload";
import type {
  DeploymentOperationPayload,
  DeploymentPlanPayload,
  ValidateResultPayload
} from "@/components/workloads/deployment/types";

type Step = "basics" | "services" | "review" | "plan" | "progress" | "done";

const SERVICES_TABS = ["Form", "Compose source"] as const;
type ServicesTab = (typeof SERVICES_TABS)[number];

type NodeOption = {
  id: string;
  name: string;
  status: string;
  isActive: boolean;
  composeSupported: boolean | null;
};

type AdminNodesPayload = {
  nodes: Array<{ id: string; name: string; status: string; isActive: boolean; composeSupported: boolean | null }>;
};
type ClientNodesPayload = {
  data: Array<{ nodeId: string; name: string; status: string; isActive: boolean; composeSupported: boolean | null }>;
};
type ClientsPayload = { clients: Array<{ id: string; name: string; slug: string }> };

const STARTER_COMPOSE = `services:
  app:
    image: nginx:stable
    ports:
      - "8080:80"
`;

function starterForm(): ComposeForm {
  const svc = emptyService("app");
  svc.image = "nginx:stable";
  return { services: [svc], networks: [], volumes: [], unsupportedTopLevel: {}, parseError: null };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/**
 * Create-workload wizard — the structured (Form) + Compose YAML creation flow.
 *
 * Both paths converge on the SAME compose document: the Form tab edits
 * structured service objects that are serialized to compose YAML, the Compose
 * source tab edits the document directly, and creation POSTs the resulting
 * document to the EXISTING deployment-create endpoint (admin or client
 * tenant). No special "simple workload" backend — the created workload is an
 * ordinary Deployment + DeploymentRevision that the deployment editor opens
 * afterwards.
 *
 * After creation the wizard can continue straight into the standard
 * plan → deploy → progress flow (reusing PlanView/OperationProgress) or hand
 * off to the workload's deployment editor for later.
 */
export function CreateWorkloadWizard({
  tenant,
  backHref,
  detailHref
}: {
  tenant: "admin" | "client";
  backHref: string;
  detailHref: (projectId: string) => string;
}): React.JSX.Element {
  const router = useRouter();
  const apiBase = tenant === "admin" ? "/api/admin/deployments" : "/api/client/deployments";
  const validateUrl = `${apiBase}/validate`;
  const nodesUrl = tenant === "admin" ? "/api/admin/nodes" : "/api/client/nodes";

  const [step, setStep] = useState<Step>("basics");
  const [tab, setTab] = useState<ServicesTab>("Form");
  const [sourceMode, setSourceMode] = useState<"form" | "yaml">("form");

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [nodeId, setNodeId] = useState("");
  const [clientId, setClientId] = useState("");

  const [compose, setCompose] = useState<string>(STARTER_COMPOSE);
  const [form, setForm] = useState<ComposeForm>(starterForm());
  const [validation, setValidation] = useState<ValidateResultPayload | null>(null);
  const [validating, setValidating] = useState(false);
  const [ackHighRisk, setAckHighRisk] = useState(false);

  const [created, setCreated] = useState<{ id: string; projectId: string; revisionId: string } | null>(null);
  const [plan, setPlan] = useState<DeploymentPlanPayload | null>(null);
  const [opId, setOpId] = useState<string | null>(null);
  const [op, setOp] = useState<DeploymentOperationPayload | null>(null);

  const nodesQuery = useQuery({
    queryKey: ["create-workload-nodes", tenant],
    queryFn: () => apiFetch<AdminNodesPayload | ClientNodesPayload>(nodesUrl)
  });
  const clientsQuery = useQuery({
    queryKey: ["create-workload-clients"],
    queryFn: () => apiFetch<ClientsPayload>("/api/admin/clients?limit=100"),
    enabled: tenant === "admin"
  });

  const nodes = useMemo<NodeOption[]>(() => {
    const raw = nodesQuery.data;
    if (!raw) return [];
    if (tenant === "admin") {
      return (raw as AdminNodesPayload).nodes.map((n) => ({
        id: n.id,
        name: n.name,
        status: n.status,
        isActive: n.isActive,
        composeSupported: n.composeSupported
      }));
    }
    return (raw as ClientNodesPayload).data.map((n) => ({
      id: n.nodeId,
      name: n.name,
      status: n.status,
      isActive: n.isActive,
      composeSupported: n.composeSupported
    }));
  }, [nodesQuery.data, tenant]);

  const slug = slugify(name);
  const composeProjectName = slug || `workload-${Date.now()}`;

  const formIssues = useMemo(() => (form ? validateComposeForm(form) : []), [form]);
  const formBlocked = hasBlockingIssues(formIssues);

  const applyForm = (next: ComposeForm): void => {
    setForm(next);
    setCompose(serializeForm(next));
    setSourceMode("form");
    setValidation(null);
  };

  const applyCompose = (next: string): void => {
    setCompose(next);
    setSourceMode("yaml");
    setValidation(null);
  };

  const switchTab = (next: ServicesTab): void => {
    if (next === "Form") {
      const parsed = parseComposeToForm(compose, []);
      if (parsed.parseError) {
        toast.error(`Compose source cannot be shown as a form yet: ${parsed.parseError}`);
        return;
      }
      setForm(parsed);
      setSourceMode("form");
      setValidation(null);
    } else {
      setSourceMode("yaml");
      setValidation(null);
    }
    setTab(next);
  };

  const runValidate = async (): Promise<ValidateResultPayload | null> => {
    if (!nodeId || compose.trim().length === 0) return null;
    setValidating(true);
    try {
      const res = await apiFetch<ValidateResultPayload>(validateUrl, {
        method: "POST",
        body: JSON.stringify({
          nodeId,
          compose,
          environment: {},
          secretReferences: sourceMode === "form" ? extractSecretReferences(form) : []
        })
      });
      setValidation(res);
      return res;
    } catch (e) {
      toast.error(deploymentErrorMessage(e));
      setValidation(null);
      return null;
    } finally {
      setValidating(false);
    }
  };

  const goReview = async (): Promise<void> => {
    if (!nodeId) {
      toast.error("Select a deployment node first.");
      return;
    }
    if (!validation) {
      const res = await runValidate();
      if (!res) return;
    }
    setStep("review");
  };

  const secretReferences = useMemo(
    () => (sourceMode === "form" ? extractSecretReferences(form) : []),
    [sourceMode, form]
  );

  const create = useMutation({
    mutationFn: () =>
      apiFetch<{ id: string; projectId: string; revisionId: string; revisionNumber: number }>(apiBase, {
        method: "POST",
        body: JSON.stringify({
          nodeId,
          name,
          slug: slug || undefined,
          description: description.trim() || null,
          clientAccountId: tenant === "admin" ? clientId || null : undefined,
          composeProjectName,
          compose,
          environment: {},
          secretReferences,
          acknowledgedFindings: ackHighRisk
            ? (validation?.highRiskFindings ?? []).map((f) => f.fingerprint ?? "")
            : []
        })
      }),
    onSuccess: (res) => {
      setCreated({ id: res.id, projectId: res.projectId, revisionId: res.revisionId });
      toast.success(`Workload created — saved as revision ${res.revisionNumber}.`);
      void generatePlan(res.id, res.revisionId);
    },
    onError: (e) => toast.error(deploymentErrorMessage(e))
  });

  const generatePlan = async (deploymentId: string, revisionId: string): Promise<void> => {
    try {
      const p = await apiFetch<DeploymentPlanPayload>(`${apiBase}/${deploymentId}/plan`, {
        method: "POST",
        body: JSON.stringify({ revisionId })
      });
      setPlan(p);
      setStep("plan");
    } catch (e) {
      toast.error(deploymentErrorMessage(e));
      setStep("done");
    }
  };

  const deploy = useMutation({
    mutationFn: async () => {
      if (!created || !plan) return;
      const res = await apiFetch<{ operationId: string }>(`${apiBase}/${created.id}/deploy`, {
        method: "POST",
        body: JSON.stringify({ revisionId: created.revisionId, planHash: plan.planHash })
      });
      setOpId(res.operationId);
      setStep("progress");
    },
    onError: (e) => {
      if (isApiError(e) && e.code === "PLAN_STALE") {
        setPlan(null);
        toast.error("The deployment plan is out of date. Generate a fresh plan before deploying.");
        if (created) void generatePlan(created.id, created.revisionId);
      } else {
        toast.error(deploymentErrorMessage(e));
      }
    }
  });

  const nodeOptions = nodes.filter((n) => n.composeSupported !== false);

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      {/* ---- STEP: BASICS ---- */}
      {step === "basics" && (
        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium uppercase tracking-wide text-text-muted" htmlFor="cw-name">
                Workload name <span className="text-critical-foreground">*</span>
              </label>
              <Input
                id="cw-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Customer portal"
              />
              {name.trim().length === 0 && (
                <p className="text-xs text-warning-foreground">Required — enter a name for this workload.</p>
              )}
              {slug && <p className="text-xs text-text-subtle">Compose project: {slug}</p>}
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium uppercase tracking-wide text-text-muted" htmlFor="cw-desc">
                Description
              </label>
              <Input
                id="cw-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What is this workload for?"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium uppercase tracking-wide text-text-muted" htmlFor="cw-node">
              Deployment node <span className="text-critical-foreground">*</span>
            </label>
            {nodesQuery.isLoading && <div className="h-10 animate-pulse rounded-control bg-panelAlt" />}
            {nodesQuery.data && nodeOptions.length === 0 && (
              <p className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning-foreground">
                {tenant === "client"
                  ? "Your account has no deployment nodes assigned yet. Ask your administrator to grant node access before you can create a workload."
                  : "No deployment nodes are available. Register an agent node first."}
              </p>
            )}
            {nodeOptions.length > 0 && (
              <Select
                id="cw-node"
                value={nodeId}
                onChange={(e) => {
                  setNodeId(e.target.value);
                  setValidation(null);
                }}
              >
                <option value="">Select a node…</option>
                {nodeOptions.map((n) => (
                  <option key={n.id} value={n.id} disabled={!n.isActive}>
                    {n.name} {!n.isActive ? "(inactive)" : ""}
                  </option>
                ))}
              </Select>
            )}
            {nodes.filter((n) => n.composeSupported === false).length > 0 && (
              <p className="text-xs text-text-subtle">
                Nodes without Compose support are hidden — Noderaft deployments require Docker Compose.
              </p>
            )}
          </div>

          {tenant === "admin" && (
            <div className="space-y-1.5">
              <label className="block text-xs font-medium uppercase tracking-wide text-text-muted" htmlFor="cw-client">
                Organization / ownership
              </label>
              <Select id="cw-client" value={clientId} onChange={(e) => setClientId(e.target.value)}>
                <option value="">Internal workload (no organization)</option>
                {(clientsQuery.data?.clients ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.slug})
                  </option>
                ))}
              </Select>
              <p className="text-xs text-text-subtle">
                Assigning an organization lets that organization&apos;s members see and manage this workload under their own account.
              </p>
            </div>
          )}

          <div className="flex items-center gap-2 pt-2">
            <Button onClick={() => setStep("services")} disabled={name.trim().length < 2 || nodeId.length === 0}>
              Continue to services
            </Button>
            <Button variant="secondary" onClick={() => router.push(backHref)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* ---- STEP: SERVICES ---- */}
      {step === "services" && (
        <div className="space-y-4">
          <TabBar tabs={SERVICES_TABS} active={tab} onChange={switchTab} idPrefix="create-workload" />

          <div id={`create-workload-panel-${tab}`} role="tabpanel" aria-labelledby={`create-workload-tab-${tab}`}>
            {tab === "Form" && (
              <WorkloadFormEditor
                form={form}
                issues={formIssues}
                onChange={applyForm}
                readOnly={false}
                secretKeys={[]}
                onRemoveService={(serviceName) => {
                  const next: ComposeForm = {
                    ...form,
                    services: form.services.filter((s) => s.name !== serviceName)
                  };
                  if (next.services.length === 0) next.services = [emptyService("app")];
                  applyForm(next);
                }}
              />
            )}

            {tab === "Compose source" && (
              <div className="space-y-2">
                <p className="text-xs text-text-subtle">
                  Advanced: edit the compose document directly. Switching back to the Form tab re-reads this source.
                </p>
                <Textarea
                  value={compose}
                  onChange={(e) => applyCompose(e.target.value)}
                  spellCheck={false}
                  className="h-[420px] resize-y font-mono text-xs leading-relaxed"
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
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() => void runValidate()}
              disabled={validating || nodeId.length === 0 || compose.trim().length === 0 || (tab === "Form" && formBlocked)}
            >
              {validating ? "Validating…" : "Validate"}
            </Button>
            <Button variant="secondary" onClick={() => setStep("basics")}>
              Back
            </Button>
            <Button onClick={() => void goReview()} disabled={validating || nodeId.length === 0}>
              Review &amp; create
            </Button>
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
                <p key={f.fingerprint ?? f.ruleId + f.message} className="mt-1 text-sm text-warning-foreground">
                  High risk — {f.message}
                </p>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ---- STEP: REVIEW ---- */}
      {step === "review" && (
        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-panel p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">Review before creating</h2>
            <dl className="grid gap-x-6 gap-y-2 text-sm md:grid-cols-2">
              <div>
                <dt className="text-xs uppercase tracking-wide text-text-muted">Name</dt>
                <dd className="font-medium">{name}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-text-muted">Compose project</dt>
                <dd className="font-mono text-xs">{composeProjectName}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-text-muted">Node</dt>
                <dd>{nodes.find((n) => n.id === nodeId)?.name ?? nodeId}</dd>
              </div>
              {tenant === "admin" && (
                <div>
                  <dt className="text-xs uppercase tracking-wide text-text-muted">Organization</dt>
                  <dd>{clientId ? clientsQuery.data?.clients.find((c) => c.id === clientId)?.name ?? clientId : "Internal (no organization)"}</dd>
                </div>
              )}
              <div>
                <dt className="text-xs uppercase tracking-wide text-text-muted">Services</dt>
                <dd>
                  {form.services.length > 0 ? (
                    <ul className="space-y-0.5">
                      {form.services.map((s) => (
                        <li key={s.id}>
                          <span className="font-mono text-xs">{s.name || "(unnamed)"}</span>
                          <span className="text-text-muted"> — {s.image || "no image"}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="text-text-muted">(raw compose document)</span>
                  )}
                </dd>
              </div>
            </dl>
          </div>

          <div className="rounded-lg border border-border bg-panel p-4">
            <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">Compose document to create</h3>
            <pre className="max-h-96 overflow-auto rounded border border-border bg-panelAlt p-3 font-mono text-xs leading-relaxed">
              {compose}
            </pre>
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
                <p key={f.fingerprint ?? f.ruleId + f.message} className="mt-1 text-sm text-warning-foreground">
                  High risk — {f.message}
                </p>
              ))}
              {!validation && null}
              {validation.valid && validation.highRiskFindings.length > 0 && (
                <label className="mt-3 flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={ackHighRisk}
                    onChange={(e) => setAckHighRisk(e.target.checked)}
                    className="h-4 w-4 accent-brand"
                  />
                  I acknowledge these high-risk findings and want to create this workload anyway.
                </label>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() => create.mutate()}
              disabled={create.isPending || !validation?.valid || (validation.highRiskFindings.length > 0 && !ackHighRisk)}
            >
              {create.isPending ? "Creating…" : "Create workload"}
            </Button>
            <Button variant="secondary" onClick={() => setStep("services")}>
              Back to services
            </Button>
            {!validation?.valid && (
              <Button variant="secondary" onClick={() => void runValidate()} disabled={validating}>
                {validating ? "Validating…" : "Validate now"}
              </Button>
            )}
          </div>
          <p className="text-xs text-text-subtle">
            Creating authors the workload definition and revision #1 only — nothing is deployed until you review a plan
            and confirm, right here or later from the workload's deployment editor.
          </p>
        </div>
      )}

      {/* ---- STEP: PLAN ---- */}
      {step === "plan" && created && (
        <div className="space-y-4">
          {plan ? (
            <PlanView
              plan={plan}
              confirmLabel="Deploy this workload"
              confirmTone="default"
              busy={deploy.isPending}
              onConfirm={() => deploy.mutate()}
            />
          ) : (
            <div className="rounded-lg border border-border bg-panel p-4 text-sm text-muted">Generating plan…</div>
          )}
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => router.push(detailHref(created.projectId))}>
              Deploy later from the workload page
            </Button>
            <Button variant="secondary" onClick={() => setStep("review")}>
              Back
            </Button>
          </div>
        </div>
      )}

      {/* ---- STEP: PROGRESS ---- */}
      {step === "progress" && created && opId && (
        <OperationProgress
          deploymentId={created.id}
          operationId={opId}
          apiBase={apiBase}
          onTerminal={(final) => {
            setOp(final);
            setStep("done");
          }}
        />
      )}

      {/* ---- STEP: DONE ---- */}
      {step === "done" && created && op && (
        <OperationResultView op={op} onDone={() => router.push(detailHref(created.projectId))} />
      )}

      {step === "done" && created && !op && (
        <div className="space-y-3">
          <div className="rounded-lg border border-border bg-panel p-4">
            <h2 className="text-sm font-semibold">Workload created</h2>
            <p className="mt-1 text-sm text-muted">
              The workload definition and revision #1 are saved. Open it to generate a deployment plan and deploy.
            </p>
          </div>
          <Button onClick={() => router.push(detailHref(created.projectId))}>Open workload</Button>
        </div>
      )}
    </div>
  );
}
