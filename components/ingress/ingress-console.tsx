"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { apiFetch } from "@/lib/fetcher";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PageHeader } from "@/components/ui/page-header";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { TabBar } from "@/components/ui/tab-bar";
import { StatePanel } from "@/components/ui/state-panel";

type ExposureType = "HTTPS" | "HTTP" | "TCP" | "UDP";
type EndpointStatus = "PENDING" | "ACTIVE" | "ERROR" | "DISABLED";
type IpVersion = "V4" | "V6";
type Allocation = "SHARED" | "DEDICATED";
type ProviderKind = "MANUAL" | "NGINX_PROXY_MANAGER";

type ClientRef = { id: string; name: string };

type Provider = { id: string; name: string; kind: ProviderKind; enabled: boolean; gatewayHostname: string | null };

type PublicAddress = {
  id: string;
  label: string;
  ipAddress: string;
  ipVersion: IpVersion;
  allocation: Allocation;
  enabled: boolean;
  reservedForOrg: { id: string; name: string } | null;
  provider: { id: string; name: string } | null;
};

type Endpoint = {
  id: string;
  clientAccount: { id: string; name: string };
  workload: { id: string; name: string };
  container: { id: string; dockerName: string } | null;
  serviceName: string | null;
  targetPort: number;
  exposureType: ExposureType;
  domain: { id: string; hostname: string; status: string } | null;
  publicAddress: { id: string; label: string; ipAddress: string };
  publicPort: number | null;
  provider: { id: string; name: string } | null;
  status: EndpointStatus;
};

type Domain = { id: string; hostname: string; status: string; clientAccountId: string };

type WorkloadRef = { id: string; name: string; containers: { id: string; dockerName: string; composeService: string | null }[] };

function statusVariant(status: EndpointStatus): "success" | "danger" | "warning" | "default" {
  if (status === "ACTIVE") return "success";
  if (status === "ERROR") return "danger";
  if (status === "PENDING") return "warning";
  return "default";
}

/**
 * Platform Ingress console (Phase 5): Endpoints, Public Addresses,
 * Providers. Platform-admin only — organizations never see this (their own
 * self-service surface is the Domains page under /organization/domains).
 */
export function IngressConsole(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"Endpoints" | "Public Addresses" | "Providers">("Endpoints");

  const endpointsQuery = useQuery({ queryKey: ["ingress-endpoints"], queryFn: () => apiFetch<{ endpoints: Endpoint[] }>("/api/admin/ingress/endpoints"), refetchInterval: 20_000 });
  const addressesQuery = useQuery({ queryKey: ["ingress-addresses"], queryFn: () => apiFetch<{ addresses: PublicAddress[] }>("/api/admin/ingress/public-addresses"), refetchInterval: 30_000 });
  const providersQuery = useQuery({ queryKey: ["ingress-providers"], queryFn: () => apiFetch<{ providers: Provider[] }>("/api/admin/ingress/providers") });
  const clientsQuery = useQuery({ queryKey: ["ingress-clients-refs"], queryFn: () => apiFetch<{ clients: ClientRef[] }>("/api/admin/clients-refs") });
  const domainsQuery = useQuery({ queryKey: ["ingress-domains"], queryFn: () => apiFetch<{ domains: Domain[] }>("/api/admin/domains") });

  const endpoints = endpointsQuery.data?.endpoints ?? [];
  const addresses = addressesQuery.data?.addresses ?? [];
  const providers = providersQuery.data?.providers ?? [];
  const clients = clientsQuery.data?.clients ?? [];
  const domains = domainsQuery.data?.domains ?? [];

  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ["ingress-endpoints"] }),
    queryClient.invalidateQueries({ queryKey: ["ingress-addresses"] }),
    queryClient.invalidateQueries({ queryKey: ["ingress-providers"] }),
    queryClient.invalidateQueries({ queryKey: ["ingress-domains"] })
  ]);

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Infrastructure" title="Ingress" description="Public endpoints, WAN addresses, and gateway providers — decoupled from any one gateway implementation." />
      <TabBar tabs={["Endpoints", "Public Addresses", "Providers"] as const} active={tab} onChange={setTab} idPrefix="ingress" />
      {tab === "Endpoints" && <EndpointsPanel endpoints={endpoints} loading={endpointsQuery.isLoading} clients={clients} domains={domains} addresses={addresses} providers={providers} refresh={refresh} />}
      {tab === "Public Addresses" && <PublicAddressesPanel addresses={addresses} loading={addressesQuery.isLoading} clients={clients} providers={providers} refresh={refresh} />}
      {tab === "Providers" && <ProvidersPanel providers={providers} loading={providersQuery.isLoading} refresh={refresh} />}
    </div>
  );
}

function EndpointsPanel({ endpoints, loading, clients, domains, addresses, providers, refresh }: {
  endpoints: Endpoint[];
  loading: boolean;
  clients: ClientRef[];
  domains: Domain[];
  addresses: PublicAddress[];
  providers: Provider[];
  refresh: () => Promise<unknown>;
}): React.JSX.Element {
  const [createOpen, setCreateOpen] = useState(false);
  const [orgId, setOrgId] = useState("");
  const [workloadId, setWorkloadId] = useState("");
  const [containerId, setContainerId] = useState("");
  const [serviceName, setServiceName] = useState("");
  const [targetPort, setTargetPort] = useState("");
  const [exposureType, setExposureType] = useState<ExposureType>("HTTPS");
  const [domainId, setDomainId] = useState("");
  const [publicAddressId, setPublicAddressId] = useState("");
  const [publicPort, setPublicPort] = useState("");
  const [providerId, setProviderId] = useState("");

  const workloadsQuery = useQuery({
    queryKey: ["ingress-workload-refs", orgId],
    queryFn: () => apiFetch<{ workloads: WorkloadRef[] }>(`/api/admin/ingress/workload-refs?clientAccountId=${orgId}`),
    enabled: Boolean(orgId)
  });
  const workloads = workloadsQuery.data?.workloads ?? [];
  const selectedWorkload = workloads.find((w) => w.id === workloadId);

  const orgDomains = domains.filter((d) => d.clientAccountId === orgId && d.status === "VERIFIED");
  const orgAddresses = addresses.filter((a) => a.enabled && (a.allocation === "SHARED" || a.reservedForOrg?.id === orgId));
  const tcpUdp = exposureType === "TCP" || exposureType === "UDP";

  function resetForm(): void {
    setOrgId(""); setWorkloadId(""); setContainerId(""); setServiceName(""); setTargetPort("");
    setExposureType("HTTPS"); setDomainId(""); setPublicAddressId(""); setPublicPort(""); setProviderId("");
  }

  const create = useMutation({
    mutationFn: () => apiFetch("/api/admin/ingress/endpoints", {
      method: "POST",
      body: JSON.stringify({
        clientAccountId: orgId,
        workloadId,
        containerId: containerId || null,
        serviceName: serviceName || null,
        targetPort: Number(targetPort),
        exposureType,
        domainId: tcpUdp ? null : domainId,
        publicAddressId,
        publicPort: tcpUdp ? Number(publicPort) : null,
        providerId: providerId || null
      })
    }),
    onSuccess: async () => { setCreateOpen(false); resetForm(); toast.success("Ingress endpoint created"); await refresh(); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not create ingress endpoint")
  });

  const updateStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: EndpointStatus }) =>
      apiFetch(`/api/admin/ingress/endpoints/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }),
    onSuccess: async () => { toast.success("Endpoint updated"); await refresh(); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not update endpoint")
  });

  const remove = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/admin/ingress/endpoints/${id}`, { method: "DELETE" }),
    onSuccess: async () => { toast.success("Endpoint deleted"); await refresh(); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not delete endpoint")
  });

  const [confirmDelete, setConfirmDelete] = useState<Endpoint | null>(null);

  const valid = Boolean(orgId && workloadId && targetPort && publicAddressId && (containerId || serviceName)) &&
    (tcpUdp ? Boolean(publicPort) : Boolean(domainId));

  return (
    <section role="tabpanel" id="ingress-panel-Endpoints" aria-labelledby="ingress-tab-Endpoints">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm text-muted">{endpoints.length} endpoint{endpoints.length === 1 ? "" : "s"}</p>
        <Button size="sm" onClick={() => setCreateOpen(true)}><Plus className="mr-1.5 h-3.5 w-3.5" /> New endpoint</Button>
      </div>
      {loading ? (
        <div className="h-32 animate-pulse rounded-lg bg-panelAlt" />
      ) : endpoints.length === 0 ? (
        <StatePanel title="No ingress endpoints" description="Publish a workload's service by creating one here." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-panelAlt/60 text-left text-xs uppercase tracking-wide text-text-subtle">
              <tr>
                <th className="px-4 py-2.5">Organization</th>
                <th className="px-4 py-2.5">Workload</th>
                <th className="px-4 py-2.5">Exposure</th>
                <th className="px-4 py-2.5">Public</th>
                <th className="px-4 py-2.5">Target</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {endpoints.map((endpoint) => (
                <tr key={endpoint.id}>
                  <td className="px-4 py-2.5 text-muted">{endpoint.clientAccount.name}</td>
                  <td className="px-4 py-2.5 font-medium text-text">{endpoint.workload.name}</td>
                  <td className="px-4 py-2.5"><Badge variant="outline">{endpoint.exposureType}</Badge></td>
                  <td className="px-4 py-2.5 text-muted">
                    {endpoint.domain ? endpoint.domain.hostname : `${endpoint.publicAddress.ipAddress}:${endpoint.publicPort}`}
                  </td>
                  <td className="px-4 py-2.5 text-muted">{endpoint.container?.dockerName ?? endpoint.serviceName ?? "—"}:{endpoint.targetPort}</td>
                  <td className="px-4 py-2.5"><Badge variant={statusVariant(endpoint.status)}>{endpoint.status}</Badge></td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-end gap-2">
                      {endpoint.status === "DISABLED" ? (
                        <Button size="sm" variant="outline" onClick={() => updateStatus.mutate({ id: endpoint.id, status: "PENDING" })}>Enable</Button>
                      ) : (
                        <Button size="sm" variant="outline" onClick={() => updateStatus.mutate({ id: endpoint.id, status: "DISABLED" })}>Disable</Button>
                      )}
                      <Button size="sm" variant="outline" className="text-critical-foreground" onClick={() => setConfirmDelete(endpoint)}>Delete</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="New ingress endpoint" size="lg">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block text-text-muted">Organization</span>
            <Select value={orgId} onChange={(e) => { setOrgId(e.target.value); setWorkloadId(""); setContainerId(""); setDomainId(""); setPublicAddressId(""); }}>
              <option value="">Select…</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-text-muted">Workload</span>
            <Select value={workloadId} onChange={(e) => { setWorkloadId(e.target.value); setContainerId(""); }} disabled={!orgId}>
              <option value="">Select…</option>
              {workloads.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-text-muted">Container</span>
            <Select value={containerId} onChange={(e) => setContainerId(e.target.value)} disabled={!selectedWorkload}>
              <option value="">Not adopted yet — set a service name instead</option>
              {selectedWorkload?.containers.map((c) => <option key={c.id} value={c.id}>{c.dockerName}</option>)}
            </Select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-text-muted">Service name{containerId ? "" : " (required if no container is selected)"}</span>
            <Input value={serviceName} onChange={(e) => setServiceName(e.target.value)} placeholder="web" disabled={Boolean(containerId)} />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-text-muted">Target port</span>
            <Input type="number" min={1} max={65535} value={targetPort} onChange={(e) => setTargetPort(e.target.value)} placeholder="8080" />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-text-muted">Exposure type</span>
            <Select value={exposureType} onChange={(e) => setExposureType(e.target.value as ExposureType)}>
              <option value="HTTPS">HTTPS</option>
              <option value="HTTP">HTTP</option>
              <option value="TCP">TCP</option>
              <option value="UDP">UDP</option>
            </Select>
          </label>
          {tcpUdp ? (
            <label className="block text-sm">
              <span className="mb-1 block text-text-muted">Public port</span>
              <Input type="number" min={1} max={65535} value={publicPort} onChange={(e) => setPublicPort(e.target.value)} placeholder="5432" />
            </label>
          ) : (
            <label className="block text-sm">
              <span className="mb-1 block text-text-muted">Domain (must be verified)</span>
              <Select value={domainId} onChange={(e) => setDomainId(e.target.value)} disabled={!orgId}>
                <option value="">Select…</option>
                {orgDomains.map((d) => <option key={d.id} value={d.id}>{d.hostname}</option>)}
              </Select>
            </label>
          )}
          <label className="block text-sm">
            <span className="mb-1 block text-text-muted">Public address</span>
            <Select value={publicAddressId} onChange={(e) => setPublicAddressId(e.target.value)} disabled={!orgId}>
              <option value="">Select…</option>
              {orgAddresses.map((a) => <option key={a.id} value={a.id}>{a.label} ({a.ipAddress}, {a.allocation.toLowerCase()})</option>)}
            </Select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-text-muted">Provider (optional)</span>
            <Select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
              <option value="">Inherit from public address</option>
              {providers.filter((p) => p.enabled).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </label>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
          <Button onClick={() => create.mutate()} disabled={!valid || create.isPending}>Create endpoint</Button>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
        onConfirm={async () => { await remove.mutateAsync(confirmDelete!.id); }}
        title={`Delete this endpoint?`}
        impact={`${confirmDelete?.workload.name ?? ""} will no longer be reachable at ${confirmDelete?.domain?.hostname ?? `${confirmDelete?.publicAddress.ipAddress}:${confirmDelete?.publicPort}`}. This frees the public address/port and domain binding for reuse.`}
        confirmLabel="Delete endpoint"
      />
    </section>
  );
}

function PublicAddressesPanel({ addresses, loading, clients, providers, refresh }: {
  addresses: PublicAddress[];
  loading: boolean;
  clients: ClientRef[];
  providers: Provider[];
  refresh: () => Promise<unknown>;
}): React.JSX.Element {
  const [createOpen, setCreateOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [ipAddress, setIpAddress] = useState("");
  const [ipVersion, setIpVersion] = useState<IpVersion>("V4");
  const [allocation, setAllocation] = useState<Allocation>("SHARED");
  const [reservedForOrgId, setReservedForOrgId] = useState("");
  const [providerId, setProviderId] = useState("");

  function resetForm(): void {
    setLabel(""); setIpAddress(""); setIpVersion("V4"); setAllocation("SHARED"); setReservedForOrgId(""); setProviderId("");
  }

  const create = useMutation({
    mutationFn: () => apiFetch("/api/admin/ingress/public-addresses", {
      method: "POST",
      body: JSON.stringify({
        label, ipAddress, ipVersion, allocation,
        reservedForOrgId: allocation === "DEDICATED" ? (reservedForOrgId || null) : null,
        providerId: providerId || null
      })
    }),
    onSuccess: async () => { setCreateOpen(false); resetForm(); toast.success("Public address added"); await refresh(); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not add public address")
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      apiFetch(`/api/admin/ingress/public-addresses/${id}`, { method: "PATCH", body: JSON.stringify({ enabled }) }),
    onSuccess: async () => { toast.success("Public address updated"); await refresh(); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not update public address")
  });

  const remove = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/admin/ingress/public-addresses/${id}`, { method: "DELETE" }),
    onSuccess: async () => { toast.success("Public address deleted"); await refresh(); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not delete public address")
  });

  const [confirmDelete, setConfirmDelete] = useState<PublicAddress | null>(null);

  return (
    <section role="tabpanel" id="ingress-panel-Public-Addresses" aria-labelledby="ingress-tab-Public-Addresses">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm text-muted">{addresses.length} address{addresses.length === 1 ? "" : "es"}</p>
        <Button size="sm" onClick={() => setCreateOpen(true)}><Plus className="mr-1.5 h-3.5 w-3.5" /> Add address</Button>
      </div>
      {loading ? (
        <div className="h-32 animate-pulse rounded-lg bg-panelAlt" />
      ) : addresses.length === 0 ? (
        <StatePanel title="No public addresses" description="Add at least one WAN address before creating ingress endpoints." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-panelAlt/60 text-left text-xs uppercase tracking-wide text-text-subtle">
              <tr>
                <th className="px-4 py-2.5">Label</th>
                <th className="px-4 py-2.5">Address</th>
                <th className="px-4 py-2.5">Allocation</th>
                <th className="px-4 py-2.5">Reserved for</th>
                <th className="px-4 py-2.5">Provider</th>
                <th className="px-4 py-2.5">Enabled</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {addresses.map((address) => (
                <tr key={address.id}>
                  <td className="px-4 py-2.5 font-medium text-text">{address.label}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-muted">{address.ipAddress} ({address.ipVersion})</td>
                  <td className="px-4 py-2.5"><Badge variant="outline">{address.allocation}</Badge></td>
                  <td className="px-4 py-2.5 text-muted">{address.reservedForOrg?.name ?? "—"}</td>
                  <td className="px-4 py-2.5 text-muted">{address.provider?.name ?? "—"}</td>
                  <td className="px-4 py-2.5"><Badge variant={address.enabled ? "success" : "default"}>{address.enabled ? "Enabled" : "Disabled"}</Badge></td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-end gap-2">
                      <Button size="sm" variant="outline" onClick={() => toggle.mutate({ id: address.id, enabled: !address.enabled })}>
                        {address.enabled ? "Disable" : "Enable"}
                      </Button>
                      <Button size="sm" variant="outline" className="text-critical-foreground" onClick={() => setConfirmDelete(address)}>Delete</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Add public address">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm sm:col-span-2">
            <span className="mb-1 block text-text-muted">Label</span>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Primary gateway" />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-text-muted">IP version</span>
            <Select value={ipVersion} onChange={(e) => setIpVersion(e.target.value as IpVersion)}>
              <option value="V4">IPv4</option>
              <option value="V6">IPv6</option>
            </Select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-text-muted">IP address</span>
            <Input value={ipAddress} onChange={(e) => setIpAddress(e.target.value)} placeholder={ipVersion === "V4" ? "203.0.113.10" : "2001:db8::1"} />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-text-muted">Allocation</span>
            <Select value={allocation} onChange={(e) => setAllocation(e.target.value as Allocation)}>
              <option value="SHARED">Shared</option>
              <option value="DEDICATED">Dedicated</option>
            </Select>
          </label>
          {allocation === "DEDICATED" && (
            <label className="block text-sm">
              <span className="mb-1 block text-text-muted">Reserved for organization</span>
              <Select value={reservedForOrgId} onChange={(e) => setReservedForOrgId(e.target.value)}>
                <option value="">Unreserved</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </label>
          )}
          <label className="block text-sm">
            <span className="mb-1 block text-text-muted">Provider (optional)</span>
            <Select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
              <option value="">None</option>
              {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </label>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
          <Button onClick={() => create.mutate()} disabled={!label.trim() || !ipAddress.trim() || create.isPending}>Add address</Button>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
        onConfirm={async () => { await remove.mutateAsync(confirmDelete!.id); }}
        title={`Delete ${confirmDelete?.label}?`}
        impact="This cannot be undone. An address still referenced by an ingress endpoint cannot be deleted."
        confirmLabel="Delete address"
      />
    </section>
  );
}

function ProvidersPanel({ providers, loading, refresh }: { providers: Provider[]; loading: boolean; refresh: () => Promise<unknown> }): React.JSX.Element {
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ProviderKind>("MANUAL");
  const [gatewayHostname, setGatewayHostname] = useState("");

  function resetForm(): void {
    setName(""); setKind("MANUAL"); setGatewayHostname("");
  }

  const create = useMutation({
    mutationFn: () => apiFetch("/api/admin/ingress/providers", {
      method: "POST",
      body: JSON.stringify({ name, kind, gatewayHostname: gatewayHostname || null })
    }),
    onSuccess: async () => { setCreateOpen(false); resetForm(); toast.success("Provider added"); await refresh(); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not add provider")
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      apiFetch(`/api/admin/ingress/providers/${id}`, { method: "PATCH", body: JSON.stringify({ enabled }) }),
    onSuccess: async () => { toast.success("Provider updated"); await refresh(); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not update provider")
  });

  const remove = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/admin/ingress/providers/${id}`, { method: "DELETE" }),
    onSuccess: async () => { toast.success("Provider deleted"); await refresh(); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not delete provider")
  });

  const [confirmDelete, setConfirmDelete] = useState<Provider | null>(null);

  return (
    <section role="tabpanel" id="ingress-panel-Providers" aria-labelledby="ingress-tab-Providers">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm text-muted">{providers.length} provider{providers.length === 1 ? "" : "s"}</p>
        <Button size="sm" onClick={() => setCreateOpen(true)}><Plus className="mr-1.5 h-3.5 w-3.5" /> Add provider</Button>
      </div>
      {loading ? (
        <div className="h-32 animate-pulse rounded-lg bg-panelAlt" />
      ) : providers.length === 0 ? (
        <StatePanel title="No ingress providers" description='Optional — endpoints work with a "MANUAL" provider (routing configured outside Noderaft) with no provider set at all.' />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-panelAlt/60 text-left text-xs uppercase tracking-wide text-text-subtle">
              <tr>
                <th className="px-4 py-2.5">Name</th>
                <th className="px-4 py-2.5">Kind</th>
                <th className="px-4 py-2.5">Gateway hostname</th>
                <th className="px-4 py-2.5">Enabled</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {providers.map((provider) => (
                <tr key={provider.id}>
                  <td className="px-4 py-2.5 font-medium text-text">{provider.name}</td>
                  <td className="px-4 py-2.5"><Badge variant="outline">{provider.kind.replace(/_/g, " ")}</Badge></td>
                  <td className="px-4 py-2.5 text-muted">{provider.gatewayHostname ?? "—"}</td>
                  <td className="px-4 py-2.5"><Badge variant={provider.enabled ? "success" : "default"}>{provider.enabled ? "Enabled" : "Disabled"}</Badge></td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-end gap-2">
                      <Button size="sm" variant="outline" onClick={() => toggle.mutate({ id: provider.id, enabled: !provider.enabled })}>
                        {provider.enabled ? "Disable" : "Enable"}
                      </Button>
                      <Button size="sm" variant="outline" className="text-critical-foreground" onClick={() => setConfirmDelete(provider)}>Delete</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Add ingress provider">
        <div className="grid gap-3">
          <label className="block text-sm">
            <span className="mb-1 block text-text-muted">Name</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Primary gateway" />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-text-muted">Kind</span>
            <Select value={kind} onChange={(e) => setKind(e.target.value as ProviderKind)}>
              <option value="MANUAL">Manual (routing configured outside Noderaft)</option>
              <option value="NGINX_PROXY_MANAGER">Nginx Proxy Manager</option>
            </Select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-text-muted">Gateway hostname (optional)</span>
            <Input value={gatewayHostname} onChange={(e) => setGatewayHostname(e.target.value)} placeholder="gw.example.net" />
            <span className="mt-1 block text-xs text-text-subtle">If set, domains are instructed to CNAME here instead of an A/AAAA record to a raw IP.</span>
          </label>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
          <Button onClick={() => create.mutate()} disabled={!name.trim() || create.isPending}>Add provider</Button>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
        onConfirm={async () => { await remove.mutateAsync(confirmDelete!.id); }}
        title={`Delete ${confirmDelete?.name}?`}
        impact="This cannot be undone. A provider still referenced by a public address or ingress endpoint cannot be deleted."
        confirmLabel="Delete provider"
      />
    </section>
  );
}
