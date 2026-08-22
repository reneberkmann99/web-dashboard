"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetcher";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { ContainerView } from "@/types/domain";

type Domain = { id: string; hostname: string; status: string };
type Address = { id: string; label: string; ipAddress: string };

export function PublishService({ workloadId, containers }: { workloadId: string; containers: ContainerView[] }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [service, setService] = useState("");
  const [port, setPort] = useState("8080");
  const [exposure, setExposure] = useState<"HTTPS" | "HTTP">("HTTPS");
  const [domainId, setDomainId] = useState("");
  const [addressId, setAddressId] = useState("");
  const [message, setMessage] = useState("");
  const domains = useQuery({ queryKey: ["publish-domains"], queryFn: () => apiFetch<{ domains: Domain[] }>("/api/client/domains"), enabled: open });
  const addresses = useQuery({ queryKey: ["publish-addresses"], queryFn: () => apiFetch<{ addresses: Address[] }>("/api/client/ingress/public-addresses"), enabled: open });
  const verified = domains.data?.domains.filter((d) => d.status === "VERIFIED") ?? [];
  const selectedContainer = containers.find((c) => c.containerId === service);
  const steps = ["Service", "Exposure & hostname", "Public Address & TLS", "Review"];

  async function activate(): Promise<void> {
    setMessage("Activating…");
    try {
      const result = await apiFetch<{ endpoint: { status: string; domain?: { hostname: string }; targetPort: number } }>("/api/client/ingress/endpoints", {
        method: "POST", body: JSON.stringify({ workloadId, containerId: service, targetPort: Number(port), exposureType: exposure, domainId, publicAddressId: addressId || addresses.data?.addresses[0]?.id })
      });
      setMessage(`${result.endpoint.domain?.hostname} · ${exposure} → ${selectedContainer?.name}:${port} · ${result.endpoint.status.replaceAll("_", " ")}`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Activation failed"); }
  }

  return <>
    <Button onClick={() => setOpen(true)}>Publish service</Button>
    <Modal open={open} onClose={() => setOpen(false)} title="Publish service" description={`${step + 1} of 4 · ${steps[step]}`} footer={<><Button variant="secondary" disabled={step === 0} onClick={() => setStep(step - 1)}>Back</Button>{step < 3 ? <Button disabled={(step === 0 && (!service || !port)) || (step === 1 && !domainId) || (step === 2 && !addresses.data?.addresses.length)} onClick={() => setStep(step + 1)}>Continue</Button> : <Button onClick={activate}>Activate</Button>}</>}>
      <div className="space-y-4">
        {step === 0 && <><label className="block text-sm">Service<Select value={service} onChange={(e) => setService(e.target.value)}><option value="">Select service</option>{containers.map((c) => <option key={c.containerId} value={c.containerId}>{c.name}</option>)}</Select></label><label className="block text-sm">Target port<Input type="number" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value)} /></label></>}
        {step === 1 && <><label className="block text-sm">Exposure<Select value={exposure} onChange={(e) => setExposure(e.target.value as "HTTP" | "HTTPS")}><option>HTTPS</option><option>HTTP</option></Select></label><label className="block text-sm">Verified hostname<Select value={domainId} onChange={(e) => setDomainId(e.target.value)}><option value="">Select hostname</option>{verified.map((d) => <option key={d.id} value={d.id}>{d.hostname}</option>)}</Select></label></>}
        {step === 2 && <><label className="block text-sm">Public Address <span className="text-muted">(Automatic recommended)</span><Select value={addressId} onChange={(e) => setAddressId(e.target.value)}><option value="">Automatic</option>{addresses.data?.addresses.map((a) => <option key={a.id} value={a.id}>{a.label} · {a.ipAddress}</option>)}</Select></label><p className="text-sm text-muted">{exposure === "HTTPS" ? "TLS is issued and renewed automatically by the gateway. Certificate keys never enter Noderaft." : "TLS is disabled for HTTP."}</p></>}
        {step === 3 && <div className="rounded-lg border border-border p-4 text-sm"><p className="font-medium">{verified.find((d) => d.id === domainId)?.hostname}</p><p>{exposure} → {selectedContainer?.name}:{port}</p><p className="text-muted">Deleting this endpoint removes public routing only. It will not delete the workload, container, volume, or domain.</p></div>}
        {message && <p role="status" className="text-sm">{message}</p>}
      </div>
    </Modal>
  </>;
}
