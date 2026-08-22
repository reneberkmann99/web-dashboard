"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch, isApiError } from "@/lib/fetcher";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import { StatePanel } from "@/components/ui/state-panel";

export type AdoptionPreview = {
  nodeId: string;
  dockerContainerId: string;
  dockerName: string;
  status: string;
  startedAt: string | null;
  fields: Array<{ field: string; verdict: "PASS" | "WARNING" | "BLOCKER"; detail: string }>;
  warnings: Array<{ field: string; verdict: "WARNING"; detail: string }>;
  blockers: Array<{ field: string; verdict: "BLOCKER"; detail: string }>;
  compose: string;
  highRiskFindings: Array<{ severity: string; ruleId: string; message: string; fingerprint?: string }>;
  alreadyManaged: boolean;
  existingWorkloadId: string | null;
  existingWorkloadName: string | null;
  nodeOnline: boolean;
};

/**
 * "Manage with Noderaft" — adoption preflight + confirm.
 *
 * The preflight is read-only (full docker inspect via the agent). Adoption
 * never recreates the running container: it authors the initial
 * deployment/revision from the inspected config, labels the live container,
 * and marks the runtime CONVERGED. Only later edits/deploys may recreate it.
 */
export function AdoptionDialog({
  nodeId,
  dockerId,
  onClose
}: {
  nodeId: string;
  dockerId: string;
  onClose: () => void;
}): React.JSX.Element {
  const router = useRouter();
  const [name, setName] = useState("");
  const [clientId, setClientId] = useState("");
  const [ack, setAck] = useState(false);

  const preview = useQuery({
    queryKey: ["adoption-preview", nodeId, dockerId],
    queryFn: () => apiFetch<AdoptionPreview>(`/api/admin/containers/direct/${nodeId}/${dockerId}/adoption`)
  });

  const clients = useQuery({
    queryKey: ["admin-clients-refs"],
    queryFn: () => apiFetch<{ data: Array<{ id: string; name: string }>; total: number }>("/api/admin/clients-refs")
  });

  const adopt = useMutation({
    mutationFn: () =>
      apiFetch<{ status: string; projectId: string; deploymentId: string; revisionId: string; revisionNumber: number; labelsApplied: boolean }>(
        `/api/admin/containers/direct/${nodeId}/${dockerId}/adoption`,
        {
          method: "POST",
          body: JSON.stringify({
            name: name || undefined,
            clientAccountId: clientId || null,
            acknowledgedFindings: ack ? (preview.data?.highRiskFindings ?? []).map((f) => f.fingerprint ?? "") : []
          })
        }
      ),
    onSuccess: (res) => {
      toast.success(
        `Adopted without recreation — the running container was left untouched${res.labelsApplied ? "" : " (labels not applied)"}. Runtime is CONVERGED.`
      );
      router.push(`/admin/workloads/${res.projectId}/deployment/edit`);
    },
    onError: (e) => {
      if (isApiError(e) && e.code === "ACK_REQUIRED") {
        toast.error("High-risk findings must be acknowledged to adopt this container.");
      } else {
        toast.error(e instanceof Error ? e.message : "Adoption failed");
      }
    }
  });

  const data = preview.data;
  const blocked = Boolean(data && data.blockers.length > 0);
  const needsAck = Boolean(data && data.highRiskFindings.length > 0);

  return (
    <Modal
      open
      onClose={onClose}
      title="Manage with Noderaft"
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={adopt.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => adopt.mutate()}
            disabled={adopt.isPending || preview.isLoading || blocked || Boolean(data?.alreadyManaged) || (needsAck && !ack)}
          >
            {adopt.isPending ? "Adopting…" : "Adopt without recreation"}
          </Button>
        </>
      }
    >
      {preview.isLoading && <div className="h-32 animate-pulse rounded-panel bg-surface-raised" />}
      {preview.isError && <StatePanel compact tone="error" title="Preflight failed" description="Could not inspect the container on this node." />}

      {data && (
        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{data.dockerName}</span>
            <Badge variant={data.status === "running" ? "success" : "warning"}>{data.status}</Badge>
            {data.alreadyManaged && <Badge variant="danger">already managed</Badge>}
          </div>

          {data.alreadyManaged && (
            <StatePanel
              compact
              tone="warning"
              title={`Already part of workload "${data.existingWorkloadName ?? "unknown"}"`}
              description="This container is already tracked by Noderaft — adopt it from that workload instead."
            />
          )}

          {blocked && (
            <StatePanel
              compact
              tone="error"
              title="This container cannot be adopted safely"
              description={
                <ul className="mt-2 space-y-1 text-left">
                  {data.blockers.map((b) => (
                    <li key={b.field} className="text-critical-foreground">
                      {b.field}: {b.detail}
                    </li>
                  ))}
                </ul>
              }
            />
          )}

          {!blocked && !data.alreadyManaged && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1.5">
                  <span className="block text-xs font-medium uppercase tracking-wide text-text-muted">Workload name</span>
                  <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={data.dockerName} />
                </label>
                <label className="space-y-1.5">
                  <span className="block text-xs font-medium uppercase tracking-wide text-text-muted">Organization (optional)</span>
                  <Select value={clientId} onChange={(e) => setClientId(e.target.value)}>
                    <option value="">Internal — no organization</option>
                    {(clients.data?.data ?? []).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                </label>
              </div>

              <div className="rounded-panel border border-border bg-surface-raised/40 p-3">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
                  What Noderaft found ({data.fields.length} checks)
                </p>
                <ul className="max-h-48 space-y-1 overflow-auto">
                  {data.fields.map((f) => (
                    <li key={f.field} className="flex items-start gap-2 text-xs">
                      <Badge
                        variant={f.verdict === "PASS" ? "success" : f.verdict === "WARNING" ? "warning" : "danger"}
                        className="shrink-0"
                      >
                        {f.verdict}
                      </Badge>
                      <span className="min-w-0">
                        <span className="font-medium text-text">{f.field}</span>
                        <span className="text-text-muted"> — {f.detail}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              {data.warnings.length > 0 && (
                <p className="text-xs text-warning-foreground">
                  {data.warnings.length} warning(s) — reproducible but worth reviewing (e.g. host bind mounts, plaintext
                  environment values).
                </p>
              )}

              {needsAck && (
                <label className="flex items-start gap-2.5 rounded-control border border-warning/30 bg-warning/10 p-3">
                  <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 h-4 w-4 accent-brand" />
                  <span>
                    <span className="block text-sm text-text">
                      Acknowledge {data.highRiskFindings.length} high-risk finding(s)
                    </span>
                    <span className="block text-xs text-warning-foreground">
                      {data.highRiskFindings.map((f) => f.message).join("; ")}
                    </span>
                  </span>
                </label>
              )}

              <p className="text-xs text-text-subtle">
                Adoption does NOT recreate, stop, or restart the running container. Noderaft records the inspected
                configuration, marks the runtime CONVERGED, and only later edits/deploys may recreate it. Named volumes
                and external networks are declared external and can never be removed by Noderaft.
              </p>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
