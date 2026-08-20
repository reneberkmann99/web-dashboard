"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch, isApiError } from "@/lib/fetcher";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ValidateResultPayload } from "@/components/workloads/deployment/types";

type AllowedNode = { nodeId: string; name: string; hostname: string; status: string; composeSupported: boolean | null; isActive: boolean };

const STARTER_COMPOSE = `services:
  app:
    image: nginx:stable
    ports:
      - "8080:80"
`;

/**
 * Client self-service: create a new managed workload on one of the account's
 * allowlisted nodes. Authored under STRICT security policy — privileged
 * containers, host binds, host networking/PID/IPC, Docker socket mounts,
 * extra capabilities, devices, and external network/volume attachment are
 * blocked outright (no acknowledgement path).
 */
export default function NewClientWorkloadPage(): React.JSX.Element {
  const router = useRouter();

  const [name, setName] = useState("");
  const [nodeId, setNodeId] = useState("");
  const [compose, setCompose] = useState(STARTER_COMPOSE);
  const [validation, setValidation] = useState<ValidateResultPayload | null>(null);
  const [validating, setValidating] = useState(false);

  const nodesQuery = useQuery({
    queryKey: ["client-allowed-nodes"],
    queryFn: () => apiFetch<{ data: AllowedNode[]; total: number }>("/api/client/nodes")
  });

  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

  const runValidate = async (): Promise<void> => {
    if (!nodeId || compose.trim().length === 0) return;
    setValidating(true);
    try {
      const res = await apiFetch<ValidateResultPayload>("/api/client/deployments/validate", {
        method: "POST",
        body: JSON.stringify({ nodeId, compose, environment: {}, secretReferences: [] })
      });
      setValidation(res);
    } catch (e) {
      toast.error(isApiError(e) ? e.message : "Validation failed");
      setValidation(null);
    } finally {
      setValidating(false);
    }
  };

  const create = useMutation({
    mutationFn: () =>
      apiFetch<{ id: string; projectId: string }>("/api/client/deployments", {
        method: "POST",
        body: JSON.stringify({
          nodeId,
          name,
          slug: slug || undefined,
          composeProjectName: slug || `workload-${Date.now()}`,
          compose,
          environment: {},
          secretReferences: [],
          acknowledgedFindings: []
        })
      }),
    onSuccess: (res) => {
      toast.success("Workload created — configure and deploy it from its detail page.");
      router.push(`/client/workloads/${res.projectId}`);
    },
    onError: (e) => toast.error(isApiError(e) ? e.message : "Failed to create workload")
  });

  const allowedNodes = nodesQuery.data?.data ?? [];

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <button type="button" onClick={() => router.push("/client/workloads")} className="mb-1 text-sm text-accent hover:underline">
          ← Workloads
        </button>
        <h1 className="text-2xl font-semibold">New workload</h1>
        <p className="text-sm text-muted">
          Create a managed service. Configurations run under strict policy — no privileged containers, host binds,
          host networking, Docker socket access, extra capabilities, or external network/volume attachment.
        </p>
      </div>

      {nodesQuery.isLoading && <div className="h-20 animate-pulse rounded-lg bg-panelAlt" />}
      {nodesQuery.data && allowedNodes.length === 0 && (
        <div className="rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm text-warning-foreground">
          Your account has no deployment nodes assigned yet. Ask your administrator to grant node access before you
          can create a workload.
        </div>
      )}

      {allowedNodes.length > 0 && (
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm text-muted" htmlFor="wl-name">
              Workload name <span className="text-danger">*</span>
            </label>
            <Input id="wl-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. My App (type your own name here)" />
            {name.trim().length === 0 && (
              <p className="mt-1 text-xs text-warning-foreground">Required — the text above is a placeholder, not a value.</p>
            )}
            {slug && <p className="mt-1 text-xs text-muted">Compose project: {slug}</p>}
          </div>

          <div>
            <label className="mb-1 block text-sm text-muted" htmlFor="wl-node">
              Deployment node
            </label>
            <select
              id="wl-node"
              value={nodeId}
              onChange={(e) => {
                setNodeId(e.target.value);
                setValidation(null);
              }}
              className="w-full rounded border border-border bg-panelAlt px-3 py-2 text-sm text-text outline-none focus:border-accent"
            >
              <option value="">Select a node…</option>
              {allowedNodes.map((n) => (
                <option key={n.nodeId} value={n.nodeId} disabled={!n.isActive || n.composeSupported === false}>
                  {n.name} {n.composeSupported === false ? "(Compose unavailable)" : ""}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-sm text-muted" htmlFor="wl-compose">
              Compose configuration
            </label>
            <textarea
              id="wl-compose"
              value={compose}
              onChange={(e) => {
                setCompose(e.target.value);
                setValidation(null);
              }}
              spellCheck={false}
              className="h-64 w-full resize-y rounded-lg border border-border bg-panelAlt p-4 font-mono text-xs leading-relaxed text-text outline-none focus:border-accent"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => void runValidate()} disabled={!nodeId || validating || compose.trim().length === 0}>
              {validating ? "Validating…" : "Validate"}
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
                  Blocked — {f.message}
                </p>
              ))}
              {validation.highRiskFindings.map((f) => (
                <p key={f.ruleId + f.message} className="mt-1 text-sm text-warning-foreground">
                  High risk — {f.message}
                </p>
              ))}
              {validation.valid && (
                <div className="mt-3">
                  <Button
                    size="sm"
                    onClick={() => create.mutate()}
                    disabled={create.isPending || name.trim().length < 2 || validation.highRiskFindings.length > 0}
                  >
                    {create.isPending ? "Creating…" : "Create workload"}
                  </Button>
                  {validation.highRiskFindings.length > 0 && (
                    <p className="mt-1.5 text-xs text-warning-foreground">
                      Resolve the high-risk findings above before creating this workload.
                    </p>
                  )}
                  {validation.highRiskFindings.length === 0 && name.trim().length < 2 && (
                    <p className="mt-1.5 text-xs text-warning-foreground">
                      Enter a workload name above (at least 2 characters) to enable this button.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
