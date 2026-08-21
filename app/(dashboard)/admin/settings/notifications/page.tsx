"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, FlaskConical, Plus, RefreshCw, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { apiFetch } from "@/lib/fetcher";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { PageHeader } from "@/components/ui/page-header";
import { Menu } from "@/components/ui/menu";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Pagination } from "@/components/ui/pagination";
import { humanizeAction } from "@/lib/format";

type EventType = "CONDITION_OPENED" | "SEVERITY_ESCALATED" | "CONDITION_RESOLVED" | "SILENCE_EXPIRED_STILL_ACTIVE";
type Destination = {
  id: string;
  name: string;
  type: "WEBHOOK";
  enabled: boolean;
  urlMasked: string;
  minSeverity: "INFO" | "WARNING" | "CRITICAL";
  eventTypes: string[];
  consecutiveFailures: number;
  lastDeliveryStatus: "PENDING" | "PROCESSING" | "DELIVERED" | "FAILED" | "SUPPRESSED" | null;
  lastDeliveryAt: string | null;
  lastSuccessAt: string | null;
};
type Delivery = {
  id: string;
  attemptNumber: number;
  status: "PENDING" | "PROCESSING" | "DELIVERED" | "FAILED" | "SUPPRESSED";
  httpStatus: number | null;
  error: string | null;
  isTest: boolean;
  isManualRetry: boolean;
  requestedAt: string;
  respondedAt: string | null;
  notificationEvent: {
    id: string;
    type: string;
    severity: string | null;
    summary: string;
    resourceType: string | null;
    resourceId: string | null;
    occurredAt: string;
  };
  destination: { id: string; name: string; urlMasked: string };
};

const availableEvents: Array<[EventType, string]> = [
  ["CONDITION_OPENED", "Opened"],
  ["SEVERITY_ESCALATED", "Escalated"],
  ["CONDITION_RESOLVED", "Resolved"],
  ["SILENCE_EXPIRED_STILL_ACTIVE", "Silence expired / still active"]
];

function localDate(value: string | null): string {
  return value ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Never";
}

function statusVariant(status: Destination["lastDeliveryStatus"] | Delivery["status"]): "success" | "danger" | "warning" | "default" {
  if (status === "DELIVERED") return "success";
  if (status === "FAILED") return "danger";
  if (status === "PENDING" || status === "PROCESSING") return "warning";
  return "default";
}

export default function NotificationsSettingsPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 25;
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [authHeader, setAuthHeader] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [minSeverity, setMinSeverity] = useState<"INFO" | "WARNING" | "CRITICAL">("WARNING");
  const [eventTypes, setEventTypes] = useState<EventType[]>(["CONDITION_OPENED", "SEVERITY_ESCALATED", "CONDITION_RESOLVED"]);

  const destinationsQuery = useQuery({
    queryKey: ["notification-destinations"],
    queryFn: () => apiFetch<{ destinations: Destination[] }>("/api/admin/notifications/destinations"),
    refetchInterval: 15_000
  });
  const deliveriesQuery = useQuery({
    queryKey: ["notification-deliveries"],
    queryFn: () => apiFetch<{ deliveries: Delivery[] }>("/api/admin/notifications/deliveries?limit=100"),
    refetchInterval: 10_000
  });
  const refresh = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["notification-destinations"] }),
      queryClient.invalidateQueries({ queryKey: ["notification-deliveries"] })
    ]);
  };
  const create = useMutation({
    mutationFn: () => apiFetch("/api/admin/notifications/destinations", {
      method: "POST",
      body: JSON.stringify({ name, url, authHeader: authHeader || null, signingSecret, minSeverity, eventTypes })
    }),
    onSuccess: async () => {
      setCreateOpen(false);
      setName(""); setUrl(""); setAuthHeader(""); setSigningSecret("");
      toast.success("Notification destination created");
      await refresh();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not create destination")
  });
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => apiFetch(`/api/admin/notifications/destinations/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled })
    }),
    onSuccess: async () => { toast.success("Destination updated"); await refresh(); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not update destination")
  });
  const sendTest = useMutation({
    mutationFn: (id: string) => apiFetch<{ delivery: Delivery }>(`/api/admin/notifications/destinations/${id}/test`, { method: "POST" }),
    onSuccess: async (data) => { data.delivery.status === "DELIVERED" ? toast.success("Test delivered") : toast.error(`Test ${data.delivery.status.toLowerCase()}`); await refresh(); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Test failed")
  });
  const retry = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/admin/notifications/deliveries/${id}/retry`, { method: "POST" }),
    onSuccess: async () => { toast.success("Retry queued"); await refresh(); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not retry delivery")
  });

  const destinations = destinationsQuery.data?.destinations ?? [];
  const deliveries = deliveriesQuery.data?.deliveries ?? [];
  const failing = destinations.filter((item) => item.consecutiveFailures >= 3);

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Alert delivery" title="Notifications" description="Global webhook destinations, delivery policy and alert-pipeline health." actions={<Button onClick={() => setCreateOpen(true)}><Plus className="mr-2 h-4 w-4" /> Add webhook</Button>} />

      {failing.length > 0 && <div className="rounded-lg border border-critical/40 bg-critical/5 p-4"><div className="flex items-center gap-2 text-critical-foreground"><TriangleAlert className="h-4 w-4" /><p className="font-medium">Notification destination failing</p></div>{failing.map((item) => <p key={item.id} className="mt-1 text-sm text-muted">{item.name}: {item.consecutiveFailures} consecutive failures. This warning is internal and does not recursively notify itself.</p>)}</div>}

      <section>
        <h2 className="mb-2 text-lg font-semibold">Destinations</h2>
        {destinationsQuery.isLoading ? <div className="h-32 animate-pulse rounded-lg bg-panelAlt" /> : destinations.length === 0 ? <div className="rounded-lg border border-border bg-panelAlt/40 p-5 text-sm"><p className="text-text">No notification destination configured yet.</p><p className="mt-1 text-muted">Noderaft still records every notification event in the delivery history below — nothing is lost while delivery is unconfigured.</p><Button className="mt-3" size="sm" onClick={() => setCreateOpen(true)}><Plus className="mr-1 h-3 w-3" /> Add webhook</Button></div> : <div className="grid gap-3 lg:grid-cols-2">{destinations.map((destination) => <div key={destination.id} className="rounded-lg border border-border bg-panel p-4">
          <div className="flex items-start justify-between gap-3"><div><div className="flex items-center gap-2"><Bell className="h-4 w-4 text-accent" /><p className="font-medium">{destination.name}</p><Badge variant={destination.enabled ? "success" : "default"}>{destination.enabled ? "enabled" : "disabled"}</Badge></div><p className="mt-1 text-xs text-muted">{destination.urlMasked}</p></div>{destination.lastDeliveryStatus && <Badge variant={statusVariant(destination.lastDeliveryStatus)}>{destination.lastDeliveryStatus.toLowerCase()}</Badge>}</div>
          <div className="mt-4 grid gap-2 text-xs text-muted sm:grid-cols-2"><p>Minimum severity: <span className="text-text">{destination.minSeverity.toLowerCase()}</span></p><p>Last success: <span className="text-text">{localDate(destination.lastSuccessAt)}</span></p><p className="sm:col-span-2">Events: {destination.eventTypes.map((event) => event.replaceAll("_", " ").toLowerCase()).join(", ")}</p></div>
          <div className="mt-4 flex flex-wrap items-center gap-2"><Button size="sm" variant="secondary" onClick={() => sendTest.mutate(destination.id)} disabled={!destination.enabled || sendTest.isPending}><FlaskConical className="mr-1 h-3 w-3" /> Send test</Button><Menu label={`Actions for ${destination.name}`} items={[{ label: destination.enabled ? "Disable destination" : "Enable destination", tone: destination.enabled ? "danger" : "default", onSelect: () => toggle.mutate({ id: destination.id, enabled: !destination.enabled }) }]} /></div>
        </div>)}</div>}
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold">Delivery history</h2>
        <div className="overflow-x-auto rounded-lg border border-border bg-panel">
          <table className="w-full min-w-[760px] text-left text-sm"><thead className="border-b border-border bg-panelAlt text-xs uppercase text-muted"><tr><th className="px-3 py-2">Event</th><th className="px-3 py-2">Destination</th><th className="px-3 py-2">Severity</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Attempt</th><th className="px-3 py-2">Time</th><th className="px-3 py-2"></th></tr></thead><tbody className="divide-y divide-border">{deliveries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((delivery) => <tr key={delivery.id}><td className="px-3 py-2"><p className="font-medium">{delivery.notificationEvent.summary}</p><p className="text-xs text-muted">{delivery.isTest ? "Test notification" : humanizeAction(delivery.notificationEvent.type)}</p></td><td className="px-3 py-2">{delivery.destination.name}</td><td className="px-3 py-2">{delivery.notificationEvent.severity?.toLowerCase() ?? "—"}</td><td className="px-3 py-2"><Badge variant={statusVariant(delivery.status)}>{delivery.status.toLowerCase()}</Badge>{delivery.error && <p className="mt-1 text-xs text-muted">{delivery.error}{delivery.httpStatus ? ` (${delivery.httpStatus})` : ""}</p>}</td><td className="px-3 py-2">{delivery.attemptNumber}{delivery.isManualRetry ? " manual" : ""}</td><td className="px-3 py-2 text-xs text-muted">{localDate(delivery.respondedAt ?? delivery.requestedAt)}</td><td className="px-3 py-2">{delivery.status === "FAILED" && <Button size="sm" variant="ghost" onClick={() => retry.mutate(delivery.id)}><RefreshCw className="mr-1 h-3 w-3" /> Retry</Button>}</td></tr>)}{deliveries.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-muted">No deliveries yet.</td></tr>}</tbody></table>
        </div>
        {deliveries.length > PAGE_SIZE && (
          <div className="mt-3">
            <Pagination
              start={page * PAGE_SIZE + 1}
              end={Math.min((page + 1) * PAGE_SIZE, deliveries.length)}
              total={deliveries.length}
              page={page + 1}
              pageCount={Math.ceil(deliveries.length / PAGE_SIZE)}
              onPageChange={(p) => setPage(p - 1)}
            />
          </div>
        )}
      </section>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Add webhook destination" description="Credentials are encrypted and never shown again after creation." footer={<><Button variant="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button><Button onClick={() => create.mutate()} disabled={create.isPending || !name || !url || signingSecret.length < 16 || eventTypes.length === 0}>Create</Button></>}>
        <div className="space-y-3"><label className="block text-sm">Display name<Input className="mt-1" value={name} onChange={(event) => setName(event.target.value)} maxLength={100} placeholder="Operations Webhook" /></label><label className="block text-sm">URL<Input type="url" className="mt-1" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://hooks.example.com/…" /></label><label className="block text-sm">Authorization header value (optional)<Input type="password" autoComplete="new-password" className="mt-1" value={authHeader} onChange={(event) => setAuthHeader(event.target.value)} placeholder="Bearer …" /></label><label className="block text-sm">HMAC signing secret<Input type="password" autoComplete="new-password" className="mt-1" value={signingSecret} onChange={(event) => setSigningSecret(event.target.value)} minLength={16} placeholder="At least 16 characters" /></label><label className="block text-sm">Minimum severity<Select className="mt-1" value={minSeverity} onChange={(event) => setMinSeverity(event.target.value as typeof minSeverity)}><option value="INFO">Info</option><option value="WARNING">Warning</option><option value="CRITICAL">Critical</option></Select></label><fieldset><legend className="text-sm">Events</legend><div className="mt-2 grid gap-2 sm:grid-cols-2">{availableEvents.map(([value, label]) => <label key={value} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={eventTypes.includes(value)} onChange={(event) => setEventTypes(event.target.checked ? [...eventTypes, value] : eventTypes.filter((item) => item !== value))} className="accent-accent" />{label}</label>)}</div></fieldset><p className="text-xs text-muted">Private/RFC1918 webhook destinations are disabled by default. Operators may explicitly enable them with WEBHOOK_ALLOW_PRIVATE_NETWORKS when an internal receiver is intentional; link-local/cloud metadata remains blocked.</p></div>
      </Modal>
    </div>
  );
}
