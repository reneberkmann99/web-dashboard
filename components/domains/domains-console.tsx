"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, RefreshCw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { apiFetch } from "@/lib/fetcher";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PageHeader } from "@/components/ui/page-header";
import { Input } from "@/components/ui/input";
import { StatePanel } from "@/components/ui/state-panel";

type DomainStatus = "PENDING_VERIFICATION" | "VERIFIED" | "INVALID" | "DISABLED";

type Domain = {
  id: string;
  hostname: string;
  status: DomainStatus;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  lastCheckError: string | null;
  clientAccount: { id: string; name: string };
  ingressEndpoints: { id: string; exposureType: string; status: string; workloadId: string }[];
};

type DnsRecord = { type: "A" | "AAAA" | "CNAME" | "TXT"; host: string; value: string };
type DnsInstructions = {
  status: DomainStatus;
  verification: DnsRecord;
  routing: (DnsRecord & { publicAddressId: string | null })[];
};

function statusVariant(status: DomainStatus): "success" | "danger" | "warning" | "default" {
  if (status === "VERIFIED") return "success";
  if (status === "INVALID" || status === "DISABLED") return "danger";
  return "warning";
}

function localDate(value: string | null): string {
  return value ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Never";
}

/**
 * Organization self-service domains (Phase 5). A CLIENT_ADMIN may add and
 * verify domains for their own organization; every other client role sees
 * the same list read-only (server/services/domains.ts is the sole
 * scope/permission enforcement point — this only hides controls that would
 * be rejected anyway). Never shows platform Public Address management —
 * that lives entirely under the platform Ingress console.
 */
export function DomainsConsole({ canManage, organizationName }: { canManage: boolean; organizationName?: string | null }): React.JSX.Element {
  const queryClient = useQueryClient();
  const apiBase = "/api/client/domains";

  const domainsQuery = useQuery({
    queryKey: ["domains", apiBase],
    queryFn: () => apiFetch<{ domains: Domain[] }>(apiBase),
    refetchInterval: 20_000
  });
  const domains = domainsQuery.data?.domains ?? [];

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["domains", apiBase] });

  const [createOpen, setCreateOpen] = useState(false);
  const [hostname, setHostname] = useState("");
  const createDomain = useMutation({
    mutationFn: () => apiFetch(apiBase, { method: "POST", body: JSON.stringify({ hostname }) }),
    onSuccess: async () => {
      setCreateOpen(false);
      setHostname("");
      toast.success("Domain added — publish the TXT record to verify it");
      await refresh();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not add domain")
  });

  const verifyDomain = useMutation({
    mutationFn: (id: string) => apiFetch<{ domain: Domain }>(`${apiBase}/${id}/verify`, { method: "POST" }),
    onSuccess: async (data) => {
      toast[data.domain.status === "VERIFIED" ? "success" : "error"](
        data.domain.status === "VERIFIED" ? "Domain verified" : "Verification record not found yet"
      );
      await refresh();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Verification check failed")
  });

  const toggleDomain = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      apiFetch(`${apiBase}/${id}`, { method: "PATCH", body: JSON.stringify({ enabled }) }),
    onSuccess: async () => { toast.success("Domain updated"); await refresh(); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not update domain")
  });

  const deleteDomain = useMutation({
    mutationFn: (id: string) => apiFetch(`${apiBase}/${id}`, { method: "DELETE" }),
    onSuccess: async () => { toast.success("Domain deleted"); await refresh(); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not delete domain")
  });

  const [confirmDelete, setConfirmDelete] = useState<{ id: string; hostname: string } | null>(null);
  const [instructionsFor, setInstructionsFor] = useState<Domain | null>(null);
  const instructionsQuery = useQuery({
    queryKey: ["domain-dns-instructions", instructionsFor?.id],
    queryFn: () => apiFetch<{ instructions: DnsInstructions }>(`${apiBase}/${instructionsFor!.id}/dns-instructions`),
    enabled: Boolean(instructionsFor)
  });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Publishing"
        title="Domains"
        description={`Hostnames ${organizationName ?? "your organization"} owns and can publish services under. Noderaft verifies ownership by DNS — it never controls DNS itself.`}
      />

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">{domains.length} domain{domains.length === 1 ? "" : "s"}</p>
        {canManage && (
          <Button size="sm" onClick={() => setCreateOpen(true)}><Plus className="mr-1.5 h-3.5 w-3.5" /> Add domain</Button>
        )}
      </div>

      {domainsQuery.isLoading ? (
        <div className="h-32 animate-pulse rounded-lg bg-panelAlt" />
      ) : domains.length === 0 ? (
        <StatePanel
          title="No domains yet"
          description={canManage ? "Add a domain to start publishing a workload under it." : "Ask an organization admin to add a domain."}
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-panelAlt/60 text-left text-xs uppercase tracking-wide text-text-subtle">
              <tr>
                <th className="px-4 py-2.5">Hostname</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Verified</th>
                <th className="px-4 py-2.5">Bound endpoint</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {domains.map((domain) => (
                <tr key={domain.id}>
                  <td className="px-4 py-2.5 font-medium text-text">{domain.hostname}</td>
                  <td className="px-4 py-2.5"><Badge variant={statusVariant(domain.status)}>{domain.status.replace(/_/g, " ")}</Badge></td>
                  <td className="px-4 py-2.5 text-muted">{localDate(domain.verifiedAt)}</td>
                  <td className="px-4 py-2.5 text-muted">
                    {domain.ingressEndpoints.length > 0
                      ? `${domain.ingressEndpoints[0].exposureType} · ${domain.ingressEndpoints[0].status}`
                      : "Not bound"}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-end gap-2">
                      <Button size="sm" variant="outline" onClick={() => setInstructionsFor(domain)}>DNS instructions</Button>
                      {canManage && domain.status !== "DISABLED" && (
                        <Button size="sm" variant="outline" onClick={() => verifyDomain.mutate(domain.id)} disabled={verifyDomain.isPending}>
                          <RefreshCw className="mr-1 h-3 w-3" /> Verify
                        </Button>
                      )}
                      {canManage && (
                        <Button size="sm" variant="outline" onClick={() => toggleDomain.mutate({ id: domain.id, enabled: domain.status === "DISABLED" })}>
                          {domain.status === "DISABLED" ? "Enable" : "Disable"}
                        </Button>
                      )}
                      {canManage && domain.ingressEndpoints.length === 0 && (
                        <Button size="sm" variant="outline" className="text-critical-foreground" onClick={() => setConfirmDelete({ id: domain.id, hostname: domain.hostname })}>
                          Delete
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Add domain" description="You'll need to publish a DNS TXT record to verify ownership before it can be used.">
        <div className="space-y-3">
          <label className="block text-sm">
            <span className="mb-1 block text-text-muted">Hostname</span>
            <Input value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="app.example.com" autoFocus />
          </label>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
          <Button onClick={() => createDomain.mutate()} disabled={!hostname.trim() || createDomain.isPending}>Add domain</Button>
        </div>
      </Modal>

      <Modal open={Boolean(instructionsFor)} onClose={() => setInstructionsFor(null)} title="DNS instructions" description={instructionsFor?.hostname} size="lg">
        {instructionsQuery.isLoading || !instructionsQuery.data ? (
          <div className="h-24 animate-pulse rounded-lg bg-panelAlt" />
        ) : (
          <div className="space-y-4 text-sm">
            <div>
              <p className="mb-1 flex items-center gap-1.5 font-medium text-text"><ShieldCheck className="h-3.5 w-3.5" /> Ownership verification (required)</p>
              <p className="text-muted">Publish this record, then click Verify.</p>
              <DnsRecordRow record={instructionsQuery.data.instructions.verification} />
            </div>
            <div>
              <p className="mb-1 font-medium text-text">Routing</p>
              {instructionsQuery.data.instructions.routing.length === 0 ? (
                <p className="text-muted">No public address is available to route this domain yet — contact your platform administrator.</p>
              ) : (
                instructionsQuery.data.instructions.routing.map((record, i) => <DnsRecordRow key={i} record={record} />)
              )}
            </div>
          </div>
        )}
        <div className="mt-5 flex justify-end">
          <Button variant="outline" onClick={() => setInstructionsFor(null)}>Close</Button>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
        onConfirm={async () => { await deleteDomain.mutateAsync(confirmDelete!.id); }}
        title={`Delete ${confirmDelete?.hostname}?`}
        impact="This cannot be undone. The domain will need to be re-added and re-verified to use it again."
        confirmLabel="Delete domain"
      />
    </div>
  );
}

function DnsRecordRow({ record }: { record: DnsRecord }): React.JSX.Element {
  return (
    <div className="mt-1.5 grid grid-cols-[3.5rem_1fr] items-center gap-x-3 gap-y-0.5 rounded-md border border-border bg-panelAlt/40 p-2.5 font-mono text-xs">
      <span className="text-text-subtle">{record.type}</span>
      <span className="truncate text-text">{record.host}</span>
      <span className="text-text-subtle">Value</span>
      <span className="truncate text-text">{record.value}</span>
    </div>
  );
}
