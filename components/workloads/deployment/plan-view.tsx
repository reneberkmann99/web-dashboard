"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { DeploymentPlanPayload } from "./types";

/**
 * Human-readable deployment plan + the guarantees the backend actually
 * enforces. The plan hash is tucked into an advanced disclosure — operators
 * never copy hashes manually; confirmations carry it automatically.
 */
export function PlanView({
  plan,
  confirmLabel,
  confirmTone = "default",
  onConfirm,
  busy,
  note
}: {
  plan: DeploymentPlanPayload;
  confirmLabel: string;
  confirmTone?: "default" | "danger" | "warning";
  onConfirm: () => void;
  busy?: boolean;
  note?: string;
}): React.JSX.Element {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const changed = plan.services.filter((s) => s.action !== "UNCHANGED");
  const hasImpact = changed.length > 0 || plan.secretChanges.some((s) => s.changed);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-panel p-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">Deployment plan</h3>
          <Badge variant="default">Revision {plan.toRevisionNumber}</Badge>
        </div>

        {!hasImpact && (
          <p className="text-sm text-muted">
            Nothing requires runtime mutation: the target configuration and secret versions already match what is
            running. No deployment is necessary.
          </p>
        )}

        {plan.services.length > 0 && (
          <div className="mt-2">
            <p className="mb-2 text-sm">
              <span className="font-medium">{changed.length}</span> of {plan.services.length} service
              {plan.services.length === 1 ? "" : "s"} affected
            </p>
            <ul className="space-y-1.5">
              {plan.services.map((s) => (
                <li key={s.serviceName} className="flex items-center gap-2 text-sm">
                  <Badge variant={s.action === "UNCHANGED" ? "default" : s.action === "RECREATE" ? "warning" : "success"}>
                    {s.action}
                  </Badge>
                  <span className="font-mono text-sm">{s.serviceName}</span>
                  {s.changes.length > 0 && <span className="truncate text-xs text-muted">— {s.changes.join(", ")}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {(plan.volumes.length > 0 || plan.networks.length > 0) && (
          <div className="mt-3">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Persistent resources</p>
            <ul className="space-y-1 text-sm">
              {plan.volumes.map((v) => (
                <li key={v.name} className="flex items-center gap-2">
                  <Badge variant="success">KEEP</Badge>
                  <span className="font-mono text-sm">{v.name}</span>
                  <span className="text-xs text-muted">volume</span>
                </li>
              ))}
              {plan.networks.map((n) => (
                <li key={n.name} className="flex items-center gap-2">
                  <Badge variant="success">KEEP</Badge>
                  <span className="font-mono text-sm">{n.name}</span>
                  <span className="text-xs text-muted">network</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {plan.secretChanges.length > 0 && (
          <div className="mt-3">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Secrets</p>
            <ul className="space-y-1 text-sm">
              {plan.secretChanges.map((s) => (
                <li key={s.key} className="flex items-center gap-2">
                  <Badge variant={s.changed ? "warning" : "default"}>{s.changed ? "UPDATE" : "UNCHANGED"}</Badge>
                  <span className="font-mono text-sm">{s.key}</span>
                  {s.changed ? (
                    <span className="text-xs text-muted">
                      → latest version
                      {s.currentVersionNumber !== null && s.targetVersionNumber !== null
                        ? ` (v${s.currentVersionNumber} → v${s.targetVersionNumber})`
                        : ""}
                    </span>
                  ) : (
                    <span className="text-xs text-muted">unchanged</span>
                  )}
                  {s.missing && <span className="text-xs text-danger">missing value!</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="rounded-lg border border-border bg-panelAlt p-4 text-sm">
        <p className="mb-1 font-semibold">Noderaft will NOT:</p>
        <ul className="list-inside list-disc space-y-0.5 text-muted">
          <li>remove named volumes or persistent networks</li>
          <li>run <span className="font-mono text-xs">docker compose down</span> or remove unrelated containers</li>
          <li>restore historical secret values — current secret versions are always used</li>
        </ul>
      </div>

      {note && <p className="text-sm text-warning-foreground">{note}</p>}

      <div className="flex items-center gap-2">
        <Button variant={confirmTone} onClick={onConfirm} disabled={busy || !hasImpact}>
          {busy ? "Working…" : confirmLabel}
        </Button>
        {!hasImpact && <span className="text-xs text-muted">No runtime changes required — no deployment needed.</span>}
      </div>

      <details className="text-xs text-muted">
        <summary className="cursor-pointer select-none">Advanced — plan hash</summary>
        <code className="mt-1 block break-all font-mono">{plan.planHash}</code>
      </details>
    </div>
  );
}
