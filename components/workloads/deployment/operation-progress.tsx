"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/fetcher";
import { Badge } from "@/components/ui/badge";
import { operationPhaseLabel } from "./labels";
import type { DeploymentOperationPayload } from "./types";

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);

const STAGES: Array<{ key: string; label: string }> = [
  { key: "REQUESTED", label: "Queued" },
  { key: "QUEUED", label: "Queued" },
  { key: "PREPARING", label: "Preparing" },
  { key: "PULLING", label: "Pulling images" },
  { key: "APPLYING", label: "Applying configuration" },
  { key: "VERIFYING", label: "Verifying health" },
  { key: "RECONCILING", label: "Recording result" }
];

/**
 * Operation progress — polls the operation endpoint until a terminal state.
 * Shows coarse-but-honest lifecycle stages derived from the real backend
 * state/phase. Polling stops on terminal state, network errors are surfaced
 * with an explicit retry rather than an endless spinner.
 */
export function OperationProgress({
  deploymentId,
  operationId,
  apiBase = "/api/admin/deployments",
  onTerminal
}: {
  deploymentId: string;
  operationId: string;
  apiBase?: string;
  onTerminal?: (op: DeploymentOperationPayload) => void;
}): React.JSX.Element {
  const [op, setOp] = useState<DeploymentOperationPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const terminalRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const data = await apiFetch<DeploymentOperationPayload>(
          `${apiBase}/${deploymentId}/operations/${operationId}`
        );
        if (cancelled) return;
        setOp(data);
        setError(null);
        if (TERMINAL.has(data.state) && !terminalRef.current) {
          terminalRef.current = true;
          onTerminal?.(data);
          return; // stop polling
        }
        timer = setTimeout(tick, 1500);
      } catch {
        if (cancelled) return;
        // Network/session failure is not a terminal operation state — retry
        // with a visible notice so the page never spins silently forever.
        setError("Lost connection to the control plane while tracking this operation. Retrying…");
        timer = setTimeout(tick, 4000);
      }
    };

    void tick();
    const clock = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      clearInterval(clock);
    };
  }, [apiBase, deploymentId, operationId, onTerminal]);

  const startedAt = op?.startedAt ? new Date(op.startedAt).getTime() : Date.now();

  return (
    <div className="rounded-lg border border-border bg-panel p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">
          {op?.type === "ROLLBACK" ? "Rollback operation" : "Deployment operation"}
        </h3>
        {op && <Badge variant={op.state === "SUCCEEDED" ? "success" : op.state === "FAILED" ? "danger" : op.state === "CANCELLED" ? "default" : "warning"}>{op.state}</Badge>}
      </div>

      <dl className="mb-4 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs uppercase text-muted">State</dt>
          <dd className="font-medium">{op ? operationPhaseLabel(op.phase, op.state) : "Starting…"}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase text-muted">Started by</dt>
          <dd className="truncate">{op?.actorEmail ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase text-muted">Elapsed</dt>
          <dd>{op?.startedAt ? `${elapsed}s` : "—"}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase text-muted">Operation</dt>
          <dd className="font-mono text-xs">{operationId.slice(-8)}</dd>
        </div>
      </dl>

      {/* Coarse lifecycle stages from real backend data — never fabricated. */}
      {op && !TERMINAL.has(op.state) && (
        <div className="space-y-1 text-sm" role="progressbar" aria-label="Operation progress">
          {STAGES.map((stage, i) => {
            const currentIndex =
              op.state === "REQUESTED" ? 0 : op.state === "QUEUED" ? 1 : STAGES.findIndex((s) => s.key === op.phase);
            const done = i < currentIndex;
            const active = i === currentIndex;
            return (
              <div key={stage.key} className={`flex items-center gap-2 ${done ? "text-green-300" : active ? "text-text" : "text-muted/60"}`}>
                <span className="w-2">{done ? "✓" : active ? "●" : "○"}</span>
                <span>{stage.label}</span>
                {stage.key === "VERIFYING" && active && <span className="text-xs text-muted">(health checks can take up to a minute)</span>}
              </div>
            );
          })}
        </div>
      )}

      {error && <p className="mt-3 text-sm text-amber-300">{error}</p>}

      {op && TERMINAL.has(op.state) && (
        <p className="mt-2 text-sm text-muted">
          {op.state === "SUCCEEDED"
            ? "Operation completed successfully."
            : op.state === "CANCELLED"
              ? "Operation was cancelled."
              : op.error
                ? `Operation failed: ${op.error}`
                : "Operation failed."}
        </p>
      )}
    </div>
  );
}
