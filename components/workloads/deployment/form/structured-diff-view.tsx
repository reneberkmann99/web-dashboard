"use client";

import { Badge } from "@/components/ui/badge";
import type { FieldChange, StructuredDiff } from "@/lib/compose-form/diff";

/**
 * Field-level change list for the Form tab review step.
 *
 * Renders "Image nginx:1.28 → nginx:1.29"-style entries instead of a raw YAML
 * diff. Secret values are redacted upstream in `lib/compose-form/diff.ts` —
 * this component only ever renders key names / secret markers.
 */
function ChangeRow({ change }: { change: FieldChange }): React.JSX.Element {
  return (
    <li className="flex flex-wrap items-baseline gap-2 py-1 text-sm">
      <Badge variant={change.kind === "added" ? "success" : change.kind === "removed" ? "danger" : "warning"}>
        {change.kind}
      </Badge>
      <span className="font-medium text-text">{change.field}</span>
      {change.before !== null && <span className="font-mono text-xs text-critical-foreground line-through">{change.before}</span>}
      {change.before !== null && change.after !== null && <span className="text-text-subtle">→</span>}
      {change.after !== null && <span className="font-mono text-xs text-success-foreground">{change.after}</span>}
    </li>
  );
}

export function StructuredDiffView({ diff }: { diff: StructuredDiff }): React.JSX.Element {
  const changedServices = diff.services.filter((s) => s.kind !== "unchanged");

  if (diff.empty) {
    return (
      <p className="text-sm text-text-muted">
        No configuration changes — the definition is identical to what you started from.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {changedServices.map((svc) => (
        <div key={svc.serviceName} className="rounded-panel border border-border bg-surface-raised/40 p-3">
          <div className="mb-1.5 flex items-center gap-2">
            <span className="font-mono text-sm text-text">{svc.serviceName}</span>
            <Badge variant={svc.kind === "added" ? "success" : svc.kind === "removed" ? "danger" : "warning"}>
              {svc.kind === "added" ? "service added" : svc.kind === "removed" ? "service removed" : "modified"}
            </Badge>
          </div>
          <ul className="divide-y divide-border/40">
            {svc.changes.map((c, i) => (
              <ChangeRow key={`${c.field}-${i}`} change={c} />
            ))}
          </ul>
        </div>
      ))}

      {diff.networks.length > 0 && (
        <div className="rounded-panel border border-border bg-surface-raised/40 p-3">
          <p className="mb-1.5 text-sm font-medium text-text">Workload networks</p>
          <ul className="divide-y divide-border/40">
            {diff.networks.map((c, i) => (
              <ChangeRow key={`net-${i}`} change={c} />
            ))}
          </ul>
        </div>
      )}

      {diff.volumes.length > 0 && (
        <div className="rounded-panel border border-border bg-surface-raised/40 p-3">
          <p className="mb-1.5 text-sm font-medium text-text">Workload volumes</p>
          <ul className="divide-y divide-border/40">
            {diff.volumes.map((c, i) => (
              <ChangeRow key={`vol-${i}`} change={c} />
            ))}
          </ul>
          <p className="mt-2 text-xs text-text-subtle">
            Removing a volume from the definition never deletes its data — named volumes are always preserved.
          </p>
        </div>
      )}
    </div>
  );
}
