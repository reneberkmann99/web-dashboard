"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch, isApiError } from "@/lib/fetcher";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { PlanView } from "./plan-view";
import { OperationProgress } from "./operation-progress";
import { OperationResultView } from "./operation-result-view";
import { deploymentErrorMessage } from "./labels";
import { timeAgo } from "@/lib/format";
import type { DeploymentOperationPayload, DeploymentPlanPayload, SecretListItem, SecretVersionListItem } from "./types";

/**
 * Secrets tab — metadata only. Rotation: new value → affected services →
 * authoritative plan → confirm → deploy → operation progress. Plaintext is
 * discarded from component state immediately after the rotation request.
 */
export function SecretsTab({ deploymentId, workloadId }: { deploymentId: string; workloadId: string }): React.JSX.Element {
  const queryClient = useQueryClient();
  const [rotating, setRotating] = useState<SecretListItem | null>(null);
  const [historyFor, setHistoryFor] = useState<SecretListItem | null>(null);

  const secrets = useQuery({
    queryKey: ["deployment-secrets", deploymentId],
    queryFn: () => apiFetch<{ data: SecretListItem[]; total: number }>(`/api/admin/deployments/${deploymentId}/secrets`),
    refetchInterval: 15000
  });

  if (secrets.isLoading) return <div className="h-40 animate-pulse rounded-lg bg-panelAlt" />;
  if (secrets.isError || !secrets.data) return <p className="text-sm text-red-400">Failed to load secrets.</p>;
  if (secrets.data.total === 0) {
    return (
      <div className="rounded-lg border border-border bg-panel p-6 text-center text-sm text-muted">
        This workload has no HostPanel-managed secrets.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        Secret values are encrypted and never displayed. Rotating a secret creates a new version and can be reconciled
        with a deployment — it never creates a new configuration revision by itself.
      </p>

      <div className="overflow-hidden rounded-lg border border-border bg-panel">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase text-muted">
              <th className="px-4 py-2.5 font-medium">Secret</th>
              <th className="px-4 py-2.5 font-medium">Version</th>
              <th className="px-4 py-2.5 font-medium">Last rotated</th>
              <th className="hidden px-4 py-2.5 font-medium sm:table-cell">Used by</th>
              <th className="px-4 py-2.5 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {secrets.data.data.map((s) => (
              <tr key={s.id} className="border-b border-border/60 last:border-0">
                <td className="px-4 py-2.5">
                  <span className="font-mono">{s.key}</span>
                  {!s.isActive && <Badge variant="default">disabled</Badge>}
                </td>
                <td className="px-4 py-2.5">v{s.latestVersion?.versionNumber ?? "—"}</td>
                <td className="px-4 py-2.5 text-muted">
                  {s.latestVersion ? timeAgo(s.latestVersion.createdAt) : "—"}
                  {s.latestVersion?.createdBy ? ` · ${s.latestVersion.createdBy}` : ""}
                </td>
                <td className="hidden px-4 py-2.5 text-muted sm:table-cell">
                  {s.usedByServices > 0 ? `${s.usedByServices} service${s.usedByServices > 1 ? "s" : ""} (${s.usedByServiceNames.join(", ")})` : "not referenced"}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="secondary" onClick={() => setHistoryFor(s)}>
                      History
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => setRotating(s)}>
                      Rotate
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {rotating && (
        <RotateFlow
          deploymentId={deploymentId}
          workloadId={workloadId}
          secret={rotating}
          onClose={() => {
            setRotating(null);
            void queryClient.invalidateQueries({ queryKey: ["deployment-secrets", deploymentId] });
            void queryClient.invalidateQueries({ queryKey: ["deployment-releases", deploymentId] });
          }}
        />
      )}

      {historyFor && (
        <SecretHistoryModal secret={historyFor} deploymentId={deploymentId} onClose={() => setHistoryFor(null)} />
      )}
    </div>
  );
}

function RotateFlow({
  deploymentId,
  workloadId,
  secret,
  onClose
}: {
  deploymentId: string;
  workloadId: string;
  secret: SecretListItem;
  onClose: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [value, setValue] = useState("");
  const [step, setStep] = useState<"input" | "plan" | "progress" | "done">("input");
  const [plan, setPlan] = useState<DeploymentPlanPayload | null>(null);
  const [opId, setOpId] = useState<string | null>(null);
  const [op, setOp] = useState<DeploymentOperationPayload | null>(null);
  const [newVersion, setNewVersion] = useState<number | null>(null);
  const [stale, setStale] = useState(false);

  const rotate = useMutation({
    mutationFn: async () => {
      const res = await apiFetch<{ id: string; versionNumber: number }>(`/api/admin/deployments/${deploymentId}/secrets/${secret.id}/versions`, {
        method: "POST",
        body: JSON.stringify({ value })
      });
      setNewVersion(res.versionNumber);
      // Immediately discard the plaintext from frontend state.
      setValue("");
      return res;
    },
    onSuccess: async () => {
      // Produce the authoritative plan for the latest revision (no revision change).
      try {
        const p = await apiFetch<DeploymentPlanPayload>(`/api/admin/deployments/${deploymentId}/plan`, {
          method: "POST",
          body: JSON.stringify({})
        });
        setPlan(p);
        setStep("plan");
      } catch (e) {
        toast.error(deploymentErrorMessage(e));
      }
    },
    onError: (e) => toast.error(deploymentErrorMessage(e))
  });

  const deploy = useMutation({
    mutationFn: async () => {
      const res = await apiFetch<{ operationId: string }>(`/api/admin/deployments/${deploymentId}/deploy`, {
        method: "POST",
        body: JSON.stringify({ revisionId: plan!.revisionId, planHash: plan!.planHash })
      });
      setOpId(res.operationId);
      setStep("progress");
    },
    onError: (e) => {
      if (isApiError(e) && e.code === "PLAN_STALE") {
        setStale(true);
        setPlan(null);
        toast.error("The plan is out of date. Generate a fresh plan.");
      } else {
        toast.error(deploymentErrorMessage(e));
      }
    }
  });

  const regenerate = async () => {
    setStale(false);
    try {
      const p = await apiFetch<DeploymentPlanPayload>(`/api/admin/deployments/${deploymentId}/plan`, {
        method: "POST",
        body: JSON.stringify({})
      });
      setPlan(p);
    } catch (e) {
      toast.error(deploymentErrorMessage(e));
    }
  };

  return (
    <Modal title={`Rotate secret ${secret.key}`} open onClose={onClose} size="lg">
      {step === "input" && (
        <div className="space-y-3">
          <p className="text-sm text-muted">
            Current version <span className="font-medium">v{secret.latestVersion?.versionNumber ?? "—"}</span>. Enter the new value — it will be
            encrypted at rest and never displayed again.
          </p>
          <input
            type="password"
            autoComplete="new-password"
            className="w-full rounded border border-border bg-panelAlt px-3 py-2 text-sm text-text outline-none focus:border-accent"
            placeholder="New secret value"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <p className="text-sm text-muted">
            {secret.usedByServices > 0 ? (
              <>
                Used by {secret.usedByServices} service{secret.usedByServices > 1 ? "s" : ""}:{" "}
                <span className="font-mono text-xs">{secret.usedByServiceNames.join(", ")}</span>. After rotation, the workload must be
                reconciled with a deployment for the new value to reach those services.
              </>
            ) : (
              "This secret is not referenced by any service in the latest configuration."
            )}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => rotate.mutate()} disabled={value.length === 0 || rotate.isPending}>
              {rotate.isPending ? "Rotating…" : "Rotate"}
            </Button>
          </div>
        </div>
      )}

      {step === "plan" && plan && (
        <div className="space-y-3">
          <p className="text-sm">
            Secret rotated to <span className="font-medium">v{newVersion}</span>. Configuration revision is unchanged — reconcile the workload
            to apply the new value.
          </p>
          {stale && <p className="text-sm text-amber-300">The plan is out of date.</p>}
          <PlanView
            plan={plan}
            confirmLabel="Deploy to reconcile"
            busy={deploy.isPending}
            onConfirm={() => deploy.mutate()}
          />
          {stale && (
            <Button size="sm" variant="secondary" onClick={() => void regenerate()}>
              Generate new plan
            </Button>
          )}
        </div>
      )}

      {step === "progress" && opId && (
        <OperationProgress
          deploymentId={deploymentId}
          operationId={opId}
          onTerminal={(final) => {
            setOp(final);
            setStep("done");
            void queryClient.invalidateQueries({ queryKey: ["deployment-secrets", deploymentId] });
            void queryClient.invalidateQueries({ queryKey: ["deployment-releases", deploymentId] });
          }}
        />
      )}

      {step === "done" && op && (
        <>
          {op.state === "SUCCEEDED" && (
            <div className="mb-3 rounded-lg border border-success/40 bg-success/10 p-3 text-sm">
              <p className="font-medium">Secret rotated successfully</p>
              <p className="mt-1 text-muted">
                <span className="font-mono">{secret.key}</span> v{newVersion! - 1} → v{newVersion}. Configuration remains the same revision;
                a new release was created after reconciling the workload.
              </p>
            </div>
          )}
          <OperationResultView op={op} deployment={{ deploymentId, workloadId }} onDone={onClose} />
        </>
      )}
    </Modal>
  );
}

function SecretHistoryModal({
  secret,
  deploymentId,
  onClose
}: {
  secret: SecretListItem;
  deploymentId: string;
  onClose: () => void;
}): React.JSX.Element {
  const versions = useQuery({
    queryKey: ["deployment-secret-versions", deploymentId, secret.id],
    queryFn: () => apiFetch<{ data: SecretVersionListItem[]; total: number }>(`/api/admin/deployments/${deploymentId}/secrets/${secret.id}`)
  });

  return (
    <Modal title={`${secret.key} — version history`} open onClose={onClose}>
      {versions.isLoading && <p className="text-sm text-muted">Loading…</p>}
      {versions.data && (
        <ul className="divide-y divide-border text-sm">
          {versions.data.data.map((v) => (
            <li key={v.id} className="flex items-center justify-between py-2">
              <span className="font-medium">v{v.versionNumber}</span>
              <span className="text-xs text-muted">
                {timeAgo(v.createdAt)} {v.createdBy ? `· ${v.createdBy}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-muted">Values are never shown — only version metadata.</p>
    </Modal>
  );
}
