"use client";

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetcher";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { StatePanel } from "@/components/ui/state-panel";

export type ServiceRemovalImpact = {
  deploymentId: string;
  serviceName: string;
  containersRemoved: Array<{ dockerName: string; dockerContainerId: string; image: string | null }>;
  networksNoLongerUsed: string[];
  networksRetained: string[];
  volumesRetained: string[];
  secretsNoLongerReferenced: string[];
  secretsRetained: string[];
  remainingServices: string[];
  removesLastService: boolean;
};

/**
 * Managed service removal confirmation.
 *
 * States the exact impact BEFORE anything is written: which containers a deploy
 * would remove, which networks are retained, that named volumes (and their
 * data) are always preserved, and which secrets stay. Confirming only authors a
 * revision — the plan/deploy steps still follow.
 */
export function RemoveServiceDialog({
  open,
  onClose,
  onConfirm,
  apiBase,
  deploymentId,
  serviceName,
  busy
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  apiBase: string;
  deploymentId: string;
  serviceName: string;
  busy?: boolean;
}): React.JSX.Element {
  const impact = useQuery({
    queryKey: ["service-removal-impact", apiBase, deploymentId, serviceName],
    queryFn: () =>
      apiFetch<ServiceRemovalImpact>(`${apiBase}/${deploymentId}/services/${encodeURIComponent(serviceName)}`),
    enabled: open
  });

  const data = impact.data;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Remove service “${serviceName}”`}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={busy || impact.isLoading || Boolean(data?.removesLastService)}>
            {busy ? "Working…" : "Remove from definition"}
          </Button>
        </>
      }
    >
      {impact.isLoading && <div className="h-24 animate-pulse rounded-panel bg-surface-raised" />}
      {impact.isError && <StatePanel compact tone="error" title="Could not load the removal impact" />}

      {data && (
        <div className="space-y-3 text-sm">
          {data.removesLastService && (
            <StatePanel
              compact
              tone="warning"
              title="This is the workload's only service"
              description="Removing it would leave an empty workload. Delete the workload instead."
            />
          )}

          <p className="text-text-muted">
            This edits the workload definition and creates a new revision. <strong>Nothing is removed from Docker
            yet</strong> — you will review a deployment plan and confirm before the runtime changes.
          </p>

          <div className="rounded-panel border border-border bg-surface-raised/40 p-3">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-muted">Containers removed on deploy</p>
            {data.containersRemoved.length === 0 ? (
              <p className="text-xs text-text-subtle">No running container is currently attributed to this service.</p>
            ) : (
              <ul className="space-y-0.5">
                {data.containersRemoved.map((c) => (
                  <li key={c.dockerContainerId} className="font-mono text-xs text-text">
                    {c.dockerName} <span className="text-text-subtle">({c.image ?? "unknown image"})</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-panel border border-border bg-surface-raised/40 p-3">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-muted">Volumes</p>
              {data.volumesRetained.length === 0 ? (
                <p className="text-xs text-text-subtle">This service mounted no named volumes.</p>
              ) : (
                <ul className="space-y-0.5">
                  {data.volumesRetained.map((v) => (
                    <li key={v} className="flex items-center gap-2 text-xs">
                      <Badge variant="success">retained</Badge>
                      <span className="font-mono">{v}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-1.5 text-xs text-text-subtle">Named volumes and their data are always preserved.</p>
            </div>

            <div className="rounded-panel border border-border bg-surface-raised/40 p-3">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-muted">Networks</p>
              {data.networksRetained.length === 0 && data.networksNoLongerUsed.length === 0 && (
                <p className="text-xs text-text-subtle">No explicit networks.</p>
              )}
              {data.networksRetained.map((n) => (
                <div key={n} className="flex items-center gap-2 text-xs">
                  <Badge variant="success">retained</Badge>
                  <span className="font-mono">{n}</span>
                </div>
              ))}
              {data.networksNoLongerUsed.map((n) => (
                <div key={n} className="flex items-center gap-2 text-xs">
                  <Badge variant="warning">unused</Badge>
                  <span className="font-mono">{n}</span>
                </div>
              ))}
              <p className="mt-1.5 text-xs text-text-subtle">External/shared networks are never removed by Noderaft.</p>
            </div>
          </div>

          {(data.secretsRetained.length > 0 || data.secretsNoLongerReferenced.length > 0) && (
            <div className="rounded-panel border border-border bg-surface-raised/40 p-3">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-muted">Secrets</p>
              {data.secretsRetained.map((k) => (
                <div key={k} className="flex items-center gap-2 text-xs">
                  <Badge variant="success">still used</Badge>
                  <span className="font-mono">{k}</span>
                </div>
              ))}
              {data.secretsNoLongerReferenced.map((k) => (
                <div key={k} className="flex items-center gap-2 text-xs">
                  <Badge variant="default">no longer referenced</Badge>
                  <span className="font-mono">{k}</span>
                </div>
              ))}
              <p className="mt-1.5 text-xs text-text-subtle">
                Secrets are retained. Removing them is a separate, explicit action.
              </p>
            </div>
          )}

          <p className="text-xs text-text-subtle">
            Remaining services: {data.remainingServices.join(", ") || "none"}
          </p>
        </div>
      )}
    </Modal>
  );
}
