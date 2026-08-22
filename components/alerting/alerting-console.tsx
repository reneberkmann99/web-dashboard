"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, FlaskConical, Mail, Plus, RefreshCw, TriangleAlert, Webhook } from "lucide-react";
import { toast } from "sonner";
import { apiFetch } from "@/lib/fetcher";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PageHeader } from "@/components/ui/page-header";
import { Menu } from "@/components/ui/menu";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { TabBar } from "@/components/ui/tab-bar";
import { Pagination } from "@/components/ui/pagination";
import { StatePanel } from "@/components/ui/state-panel";
import { humanizeAction } from "@/lib/format";

type DestinationType = "WEBHOOK" | "EMAIL";
type Severity = "INFO" | "WARNING" | "CRITICAL";
type RuleScope = "PLATFORM" | "ORGANIZATION";
type DeliveryStatus = "PENDING" | "PROCESSING" | "DELIVERED" | "FAILED" | "SUPPRESSED";
type EventType =
  | "CONDITION_OPENED"
  | "SEVERITY_ESCALATED"
  | "CONDITION_RESOLVED"
  | "SILENCE_EXPIRED_STILL_ACTIVE"
  | "DEPLOYMENT_FAILED"
  | "DEPLOYMENT_SUCCEEDED";

type ClientRef = { id: string; name: string };

type Destination = {
  id: string;
  name: string;
  type: DestinationType;
  enabled: boolean;
  clientAccountId: string | null;
  urlMasked: string | null;
  emailRecipients: string[];
  consecutiveFailures: number;
  lastDeliveryStatus: DeliveryStatus | null;
  lastDeliveryAt: string | null;
  lastSuccessAt: string | null;
};

type Rule = {
  id: string;
  name: string;
  scope: RuleScope;
  clientAccountId: string | null;
  eventTypes: EventType[];
  minSeverity: Severity;
  destinationId: string;
  enabled: boolean;
  destination: { id: string; name: string; type: DestinationType };
};

type Delivery = {
  id: string;
  attemptNumber: number;
  status: DeliveryStatus;
  httpStatus: number | null;
  error: string | null;
  emailFailureClass: string | null;
  isTest: boolean;
  isManualRetry: boolean;
  requestedAt: string;
  startedAt: string | null;
  respondedAt: string | null;
  notificationEvent: {
    id: string;
    type: string;
    severity: Severity | null;
    summary: string;
    resourceType: string | null;
    resourceId: string | null;
    occurredAt: string;
    payload: { detail?: string; organization?: { name: string } | null; resource?: { name?: string } } | null;
  };
  destination: { id: string; name: string; type: DestinationType; urlMasked: string | null };
};

const EVENT_LABEL: Record<EventType, string> = {
  CONDITION_OPENED: "Attention condition opened",
  SEVERITY_ESCALATED: "Severity escalated",
  CONDITION_RESOLVED: "Condition resolved",
  SILENCE_EXPIRED_STILL_ACTIVE: "Silence expired / still active",
  DEPLOYMENT_FAILED: "Deployment failed",
  DEPLOYMENT_SUCCEEDED: "Deployment succeeded"
};
const RULE_EVENT_OPTIONS = Object.keys(EVENT_LABEL) as EventType[];
// DEPLOYMENT_SUCCEEDED is deliberately excluded from the default selection —
// successful-deployment notifications are opt-in, not default (brief).
const DEFAULT_RULE_EVENTS: EventType[] = ["CONDITION_OPENED", "SEVERITY_ESCALATED", "CONDITION_RESOLVED", "DEPLOYMENT_FAILED"];

function localDate(value: string | null): string {
  return value ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Never";
}

function statusVariant(status: DeliveryStatus | null): "success" | "danger" | "warning" | "default" {
  if (status === "DELIVERED") return "success";
  if (status === "FAILED") return "danger";
  if (status === "PENDING" || status === "PROCESSING") return "warning";
  return "default";
}

function severityVariant(severity: Severity | null): "danger" | "warning" | "default" {
  if (severity === "CRITICAL") return "danger";
  if (severity === "WARNING") return "warning";
  return "default";
}

function parseEmailList(raw: string): string[] {
  return Array.from(new Set(raw.split(/[,\n]/).map((value) => value.trim()).filter(Boolean)));
}

/**
 * Shared alerting UI (Phase 4): destinations, routing rules, and delivery
 * history. Used by both the Platform Admin Alerting page (`mode="admin"`,
 * every organization plus a Platform scope) and the Organization Alerting
 * page (`mode="organization"`, hard-scoped to the caller's own org with no
 * scope picker at all — the API layer forces every write onto their own
 * clientAccountId regardless of what this UI sends). Never trust this
 * component's own scoping for security — server/services/notifications.ts is
 * the sole enforcement point; this only avoids offering controls that would
 * be rejected anyway.
 */
export function AlertingConsole({ apiBase, mode, organizationName }: {
  apiBase: string;
  mode: "admin" | "organization";
  organizationName?: string | null;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"Destinations" | "Rules" | "Delivery history">("Destinations");
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 25;

  const destinationsQuery = useQuery({
    queryKey: ["alerting-destinations", apiBase],
    queryFn: () => apiFetch<{ destinations: Destination[] }>(`${apiBase}/destinations`),
    refetchInterval: 15_000
  });
  const rulesQuery = useQuery({
    queryKey: ["alerting-rules", apiBase],
    queryFn: () => apiFetch<{ rules: Rule[] }>(`${apiBase}/rules`),
    refetchInterval: 15_000
  });
  const deliveriesQuery = useQuery({
    queryKey: ["alerting-deliveries", apiBase],
    queryFn: () => apiFetch<{ deliveries: Delivery[] }>(`${apiBase}/deliveries?limit=100`),
    refetchInterval: 10_000
  });
  const clientsQuery = useQuery({
    queryKey: ["alerting-clients-refs"],
    queryFn: () => apiFetch<{ clients: ClientRef[] }>("/api/admin/clients-refs"),
    enabled: mode === "admin"
  });

  const refresh = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["alerting-destinations", apiBase] }),
      queryClient.invalidateQueries({ queryKey: ["alerting-rules", apiBase] }),
      queryClient.invalidateQueries({ queryKey: ["alerting-deliveries", apiBase] })
    ]);
  };

  const destinations = destinationsQuery.data?.destinations ?? [];
  const rules = rulesQuery.data?.rules ?? [];
  const deliveries = deliveriesQuery.data?.deliveries ?? [];
  const clients = clientsQuery.data?.clients ?? [];
  const clientNameById = useMemo(() => new Map(clients.map((c) => [c.id, c.name])), [clients]);
  const scopeLabel = (clientAccountId: string | null): string =>
    clientAccountId ? (clientNameById.get(clientAccountId) ?? "Organization") : "Platform";

  const noDestinations = destinations.length === 0;
  const failing = destinations.filter((item) => item.consecutiveFailures >= 3);

  // ---- Create destination ----
  const [createDestOpen, setCreateDestOpen] = useState(false);
  const [destType, setDestType] = useState<DestinationType>("WEBHOOK");
  const [destName, setDestName] = useState("");
  const [destOrgScope, setDestOrgScope] = useState<"PLATFORM" | "ORGANIZATION">(mode === "organization" ? "ORGANIZATION" : "PLATFORM");
  const [destClientAccountId, setDestClientAccountId] = useState("");
  const [destUrl, setDestUrl] = useState("");
  const [destAuthHeader, setDestAuthHeader] = useState("");
  const [destSigningSecret, setDestSigningSecret] = useState("");
  const [destEmails, setDestEmails] = useState("");

  function resetDestForm(): void {
    setDestType("WEBHOOK");
    setDestName("");
    setDestOrgScope(mode === "organization" ? "ORGANIZATION" : "PLATFORM");
    setDestClientAccountId("");
    setDestUrl("");
    setDestAuthHeader("");
    setDestSigningSecret("");
    setDestEmails("");
  }

  const createDestination = useMutation({
    mutationFn: () => {
      const clientAccountId = mode === "admin" && destOrgScope === "ORGANIZATION" ? destClientAccountId : undefined;
      const body = destType === "WEBHOOK"
        ? { type: "WEBHOOK", name: destName, url: destUrl, authHeader: destAuthHeader || null, signingSecret: destSigningSecret, clientAccountId }
        : { type: "EMAIL", name: destName, emailRecipients: parseEmailList(destEmails), clientAccountId };
      return apiFetch(`${apiBase}/destinations`, { method: "POST", body: JSON.stringify(body) });
    },
    onSuccess: async () => {
      setCreateDestOpen(false);
      resetDestForm();
      toast.success("Destination created");
      await refresh();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not create destination")
  });
  const destValid = destType === "WEBHOOK"
    ? Boolean(destName && destUrl && destSigningSecret.length >= 16)
    : Boolean(destName && parseEmailList(destEmails).length > 0);
  const destScopeValid = mode === "admin" && destOrgScope === "ORGANIZATION" ? Boolean(destClientAccountId) : true;

  const toggleDestination = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      apiFetch(`${apiBase}/destinations/${id}`, { method: "PATCH", body: JSON.stringify({ enabled }) }),
    onSuccess: async () => { toast.success("Destination updated"); await refresh(); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not update destination")
  });
  const sendTest = useMutation({
    mutationFn: (id: string) => apiFetch<{ delivery: Delivery }>(`${apiBase}/destinations/${id}/test`, { method: "POST" }),
    onSuccess: async (data) => { data.delivery.status === "DELIVERED" ? toast.success("Test delivered") : toast.error(`Test ${data.delivery.status.toLowerCase()}`); await refresh(); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Test failed")
  });
  const deleteDestination = useMutation({
    mutationFn: (id: string) => apiFetch(`${apiBase}/destinations/${id}`, { method: "DELETE" }),
    onSuccess: async () => { toast.success("Destination deleted"); await refresh(); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not delete destination")
  });

  // ---- Create rule ----
  const [createRuleOpen, setCreateRuleOpen] = useState(false);
  const [ruleName, setRuleName] = useState("");
  const [ruleScope, setRuleScope] = useState<RuleScope>(mode === "organization" ? "ORGANIZATION" : "PLATFORM");
  const [ruleClientAccountId, setRuleClientAccountId] = useState("");
  const [ruleEventTypes, setRuleEventTypes] = useState<EventType[]>(DEFAULT_RULE_EVENTS);
  const [ruleMinSeverity, setRuleMinSeverity] = useState<Severity>("WARNING");
  const [ruleDestinationId, setRuleDestinationId] = useState("");

  function resetRuleForm(): void {
    setRuleName("");
    setRuleScope(mode === "organization" ? "ORGANIZATION" : "PLATFORM");
    setRuleClientAccountId("");
    setRuleEventTypes(DEFAULT_RULE_EVENTS);
    setRuleMinSeverity("WARNING");
    setRuleDestinationId("");
  }

  // A rule may only route to a destination whose own scope matches — same
  // constraint the server enforces, mirrored here so the picker never offers
  // an option that would be rejected.
  const eligibleRuleDestinations = destinations.filter((d) => {
    if (mode === "organization") return true; // server already scopes the list to this org
    if (ruleScope === "PLATFORM") return d.clientAccountId === null;
    return d.clientAccountId === ruleClientAccountId;
  });

  const createRule = useMutation({
    mutationFn: () => {
      const clientAccountId = mode === "admin" && ruleScope === "ORGANIZATION" ? ruleClientAccountId : undefined;
      return apiFetch(`${apiBase}/rules`, {
        method: "POST",
        body: JSON.stringify({
          name: ruleName,
          scope: ruleScope,
          clientAccountId,
          eventTypes: ruleEventTypes,
          minSeverity: ruleMinSeverity,
          destinationId: ruleDestinationId
        })
      });
    },
    onSuccess: async () => {
      setCreateRuleOpen(false);
      resetRuleForm();
      toast.success("Rule created");
      await refresh();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not create rule")
  });
  const ruleValid = Boolean(ruleName && ruleEventTypes.length > 0 && ruleDestinationId) &&
    (mode === "organization" || ruleScope === "PLATFORM" || Boolean(ruleClientAccountId));

  const toggleRule = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      apiFetch(`${apiBase}/rules/${id}`, { method: "PATCH", body: JSON.stringify({ enabled }) }),
    onSuccess: async () => { toast.success("Rule updated"); await refresh(); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not update rule")
  });
  const deleteRule = useMutation({
    mutationFn: (id: string) => apiFetch(`${apiBase}/rules/${id}`, { method: "DELETE" }),
    onSuccess: async () => { toast.success("Rule deleted"); await refresh(); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not delete rule")
  });

  const retry = useMutation({
    mutationFn: (id: string) => apiFetch(`${apiBase}/deliveries/${id}/retry`, { method: "POST" }),
    onSuccess: async () => { toast.success("Retry queued"); await refresh(); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not retry delivery")
  });

  const [confirmDelete, setConfirmDelete] = useState<{ kind: "destination" | "rule"; id: string; name: string } | null>(null);
  const [selectedDelivery, setSelectedDelivery] = useState<Delivery | null>(null);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Alert delivery"
        title="Alerting"
        description={mode === "admin"
          ? "Platform-wide and organization alert destinations, routing rules, and delivery health."
          : `Alert destinations and routing rules for ${organizationName ?? "your organization"}.`}
      />

      {failing.length > 0 && (
        <div className="rounded-lg border border-critical/40 bg-critical/5 p-4">
          <div className="flex items-center gap-2 text-critical-foreground"><TriangleAlert className="h-4 w-4" /><p className="font-medium">Notification destination failing</p></div>
          {failing.map((item) => <p key={item.id} className="mt-1 text-sm text-muted">{item.name}: {item.consecutiveFailures} consecutive failures. This warning is internal and does not recursively notify itself.</p>)}
        </div>
      )}

      <TabBar tabs={["Destinations", "Rules", "Delivery history"] as const} active={tab} onChange={setTab} idPrefix="alerting" />

      {tab === "Destinations" && (
        <section role="tabpanel" id="alerting-panel-Destinations" aria-labelledby="alerting-tab-Destinations">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm text-muted">{destinations.length} destination{destinations.length === 1 ? "" : "s"}</p>
            {!noDestinations && <Button size="sm" onClick={() => setCreateDestOpen(true)}><Plus className="mr-1.5 h-3.5 w-3.5" /> Add destination</Button>}
          </div>
          {destinationsQuery.isLoading ? (
            <div className="h-32 animate-pulse rounded-lg bg-panelAlt" />
          ) : noDestinations ? (
            <div className="rounded-lg border border-border bg-panelAlt/40 p-5 text-sm">
              <p className="text-text">No alert destinations configured.</p>
              <p className="mt-1 text-muted">Noderaft still records every Attention condition and Activity event internally — nothing is lost while delivery is unconfigured.</p>
              <Button className="mt-3" size="sm" onClick={() => setCreateDestOpen(true)}><Plus className="mr-1 h-3 w-3" /> Add destination</Button>
            </div>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {destinations.map((destination) => (
                <div key={destination.id} className="rounded-lg border border-border bg-panel p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        {destination.type === "EMAIL" ? <Mail className="h-4 w-4 text-accent" /> : <Webhook className="h-4 w-4 text-accent" />}
                        <p className="font-medium">{destination.name}</p>
                        <Badge variant={destination.enabled ? "success" : "neutral"}>{destination.enabled ? "enabled" : "disabled"}</Badge>
                        {mode === "admin" && <Badge variant="default">{scopeLabel(destination.clientAccountId)}</Badge>}
                      </div>
                      <p className="mt-1 text-xs text-muted">
                        {destination.type === "WEBHOOK" ? destination.urlMasked : `${destination.emailRecipients.length} recipient${destination.emailRecipients.length === 1 ? "" : "s"}: ${destination.emailRecipients.join(", ")}`}
                      </p>
                    </div>
                    {destination.lastDeliveryStatus && <Badge variant={statusVariant(destination.lastDeliveryStatus)}>{destination.lastDeliveryStatus.toLowerCase()}</Badge>}
                  </div>
                  <div className="mt-4 grid gap-2 text-xs text-muted sm:grid-cols-2">
                    <p>Last success: <span className="text-text">{localDate(destination.lastSuccessAt)}</span></p>
                    <p>Last attempt: <span className="text-text">{localDate(destination.lastDeliveryAt)}</span></p>
                  </div>
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="secondary" onClick={() => sendTest.mutate(destination.id)} disabled={!destination.enabled || sendTest.isPending}>
                      <FlaskConical className="mr-1 h-3 w-3" /> Send test
                    </Button>
                    <Menu label={`Actions for ${destination.name}`} items={[
                      { label: destination.enabled ? "Disable destination" : "Enable destination", onSelect: () => toggleDestination.mutate({ id: destination.id, enabled: !destination.enabled }) },
                      { label: "Delete destination", tone: "danger", onSelect: () => setConfirmDelete({ kind: "destination", id: destination.id, name: destination.name }) }
                    ]} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {tab === "Rules" && (
        <section role="tabpanel" id="alerting-panel-Rules" aria-labelledby="alerting-tab-Rules">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm text-muted">{rules.length} rule{rules.length === 1 ? "" : "s"}</p>
            <Button size="sm" onClick={() => setCreateRuleOpen(true)} disabled={destinations.length === 0}><Plus className="mr-1.5 h-3.5 w-3.5" /> Add rule</Button>
          </div>
          {destinations.length === 0 && rulesQuery.isSuccess && (
            <p className="mb-3 text-xs text-muted">Add a destination first — a rule routes events to one.</p>
          )}
          {rulesQuery.isLoading ? (
            <div className="h-32 animate-pulse rounded-lg bg-panelAlt" />
          ) : rules.length === 0 ? (
            <StatePanel title="No rules configured" description="Nothing is routed to a destination yet — attention and deployment events are still recorded internally." />
          ) : (
            <div className="space-y-2.5">
              {rules.map((rule) => (
                <div key={rule.id} className="rounded-lg border border-border bg-panel p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <Bell className="h-4 w-4 text-accent" />
                        <p className="font-medium">{rule.name}</p>
                        <Badge variant={rule.enabled ? "success" : "neutral"}>{rule.enabled ? "enabled" : "disabled"}</Badge>
                        {mode === "admin" && <Badge variant="default">{scopeLabel(rule.clientAccountId)}</Badge>}
                      </div>
                      <p className="mt-1 text-xs text-muted">
                        Minimum severity <span className="text-text">{rule.minSeverity.toLowerCase()}</span> → {rule.destination.type === "EMAIL" ? "email" : "webhook"} <span className="text-text">{rule.destination.name}</span>
                      </p>
                      <p className="mt-1 text-xs text-muted">{rule.eventTypes.map((event) => EVENT_LABEL[event]).join(", ")}</p>
                    </div>
                    <Menu label={`Actions for ${rule.name}`} items={[
                      { label: rule.enabled ? "Disable rule" : "Enable rule", onSelect: () => toggleRule.mutate({ id: rule.id, enabled: !rule.enabled }) },
                      { label: "Delete rule", tone: "danger", onSelect: () => setConfirmDelete({ kind: "rule", id: rule.id, name: rule.name }) }
                    ]} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {tab === "Delivery history" && (
        <section role="tabpanel" id="alerting-panel-Delivery history" aria-labelledby="alerting-tab-Delivery history">
          <div className="hidden overflow-x-auto rounded-lg border border-border bg-panel md:block">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead className="border-b border-border bg-panelAlt text-xs uppercase text-muted">
                <tr><th className="px-3 py-2">Event</th><th className="px-3 py-2">Destination</th><th className="px-3 py-2">Channel</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Attempt</th><th className="px-3 py-2">Time</th><th className="px-3 py-2" /></tr>
              </thead>
              <tbody className="divide-y divide-border">
                {deliveries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((delivery) => (
                  <tr key={delivery.id} className="cursor-pointer hover:bg-panelAlt/40" onClick={() => setSelectedDelivery(delivery)}>
                    <td className="px-3 py-2">
                      <p className="font-medium">{delivery.notificationEvent.summary}</p>
                      <p className="text-xs text-muted">{delivery.isTest ? "Test notification" : humanizeAction(delivery.notificationEvent.type)}{delivery.notificationEvent.severity ? ` · ${delivery.notificationEvent.severity.toLowerCase()}` : ""}</p>
                    </td>
                    <td className="px-3 py-2">{delivery.destination.name}</td>
                    <td className="px-3 py-2">{delivery.destination.type === "EMAIL" ? "Email" : "Webhook"}</td>
                    <td className="px-3 py-2">
                      <Badge variant={statusVariant(delivery.status)}>{delivery.status.toLowerCase()}</Badge>
                      {delivery.error && <p className="mt-1 text-xs text-muted">{delivery.error}{delivery.httpStatus ? ` (${delivery.httpStatus})` : ""}</p>}
                    </td>
                    <td className="px-3 py-2">{delivery.attemptNumber}{delivery.isManualRetry ? " manual" : ""}</td>
                    <td className="px-3 py-2 text-xs text-muted">{localDate(delivery.respondedAt ?? delivery.requestedAt)}</td>
                    <td className="px-3 py-2">
                      {delivery.status === "FAILED" && (
                        <Button size="sm" variant="ghost" onClick={(event) => { event.stopPropagation(); retry.mutate(delivery.id); }}>
                          <RefreshCw className="mr-1 h-3 w-3" /> Retry
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
                {deliveries.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-muted">No deliveries yet.</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="space-y-2.5 md:hidden">
            {deliveries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((delivery) => (
              <div key={delivery.id} className="rounded-[12px] border border-border bg-surface-deck p-3.5" onClick={() => setSelectedDelivery(delivery)}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium leading-5">{delivery.notificationEvent.summary}</p>
                    <p className="mt-0.5 font-mono text-[11px] text-text-muted">{delivery.isTest ? "Test notification" : humanizeAction(delivery.notificationEvent.type)}</p>
                  </div>
                  <Badge variant={statusVariant(delivery.status)}>{delivery.status.toLowerCase()}</Badge>
                </div>
                <div className="mt-2.5 flex items-center justify-between gap-3 font-mono text-[11px] text-text-muted">
                  <span className="truncate">{delivery.destination.name} · {delivery.destination.type === "EMAIL" ? "email" : "webhook"}</span>
                  <span className="flex-none">#{delivery.attemptNumber}{delivery.isManualRetry ? " manual" : ""}</span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-3">
                  <span className="truncate font-mono text-[11px] text-text-subtle">{localDate(delivery.respondedAt ?? delivery.requestedAt)}</span>
                  {delivery.status === "FAILED" && (
                    <Button size="sm" variant="ghost" onClick={(event) => { event.stopPropagation(); retry.mutate(delivery.id); }}>
                      <RefreshCw className="mr-1 h-3 w-3" /> Retry
                    </Button>
                  )}
                </div>
                {delivery.error && <p className="mt-1.5 break-words text-xs text-critical-foreground">{delivery.error}{delivery.httpStatus ? ` (${delivery.httpStatus})` : ""}</p>}
              </div>
            ))}
            {deliveries.length === 0 && <p className="rounded-[12px] border border-border bg-surface-raised/40 px-4 py-5 text-center text-sm text-text-muted">No deliveries yet.</p>}
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
      )}

      {/* Delivery detail — safe fields only: no secrets, no raw webhook payload beyond what's already shown in-app. */}
      <Modal open={selectedDelivery !== null} onClose={() => setSelectedDelivery(null)} title="Delivery detail">
        {selectedDelivery && (
          <div className="space-y-3 text-sm">
            <div className="flex items-center gap-2">
              {selectedDelivery.notificationEvent.severity && <Badge variant={severityVariant(selectedDelivery.notificationEvent.severity)}>{selectedDelivery.notificationEvent.severity.toLowerCase()}</Badge>}
              <Badge variant={statusVariant(selectedDelivery.status)}>{selectedDelivery.status.toLowerCase()}</Badge>
            </div>
            <p className="font-medium">{selectedDelivery.notificationEvent.summary}</p>
            {selectedDelivery.notificationEvent.payload?.detail && <p className="text-muted">{selectedDelivery.notificationEvent.payload.detail}</p>}
            <div className="grid gap-2 border-t border-border pt-3 sm:grid-cols-2">
              <p className="text-muted">Destination <span className="block text-text">{selectedDelivery.destination.name} ({selectedDelivery.destination.type === "EMAIL" ? "email" : "webhook"})</span></p>
              {selectedDelivery.notificationEvent.payload?.organization && <p className="text-muted">Organization <span className="block text-text">{selectedDelivery.notificationEvent.payload.organization.name}</span></p>}
              <p className="text-muted">Attempt <span className="block text-text">{selectedDelivery.attemptNumber}{selectedDelivery.isManualRetry ? " (manual retry)" : ""}</span></p>
              <p className="text-muted">Requested <span className="block text-text">{localDate(selectedDelivery.requestedAt)}</span></p>
              <p className="text-muted">Responded <span className="block text-text">{localDate(selectedDelivery.respondedAt)}</span></p>
              {selectedDelivery.httpStatus !== null && <p className="text-muted">HTTP status <span className="block text-text">{selectedDelivery.httpStatus}</span></p>}
              {selectedDelivery.emailFailureClass && <p className="text-muted">Failure class <span className="block text-text">{selectedDelivery.emailFailureClass.replaceAll("_", " ").toLowerCase()}</span></p>}
              {selectedDelivery.error && <p className="text-muted">Error <span className="block text-text">{selectedDelivery.error}</span></p>}
            </div>
            {selectedDelivery.status === "FAILED" && (
              <Button size="sm" variant="secondary" onClick={() => { retry.mutate(selectedDelivery.id); setSelectedDelivery(null); }}>
                <RefreshCw className="mr-1 h-3 w-3" /> Retry delivery
              </Button>
            )}
          </div>
        )}
      </Modal>

      {/* ---- Create destination ---- */}
      <Modal
        open={createDestOpen}
        onClose={() => setCreateDestOpen(false)}
        title="Add destination"
        description="Credentials are encrypted and never shown again after creation."
        footer={<>
          <Button variant="secondary" onClick={() => setCreateDestOpen(false)}>Cancel</Button>
          <Button onClick={() => createDestination.mutate()} disabled={createDestination.isPending || !destValid || !destScopeValid}>Create</Button>
        </>}
      >
        <div className="space-y-3">
          <fieldset>
            <legend className="text-sm">Type</legend>
            <div className="mt-1.5 flex gap-2">
              <Button type="button" size="sm" variant={destType === "WEBHOOK" ? "default" : "secondary"} onClick={() => setDestType("WEBHOOK")}><Webhook className="mr-1.5 h-3.5 w-3.5" /> Webhook</Button>
              <Button type="button" size="sm" variant={destType === "EMAIL" ? "default" : "secondary"} onClick={() => setDestType("EMAIL")}><Mail className="mr-1.5 h-3.5 w-3.5" /> Email</Button>
            </div>
          </fieldset>
          <label className="block text-sm">Display name<Input className="mt-1" value={destName} onChange={(event) => setDestName(event.target.value)} maxLength={100} placeholder={destType === "WEBHOOK" ? "Operations Webhook" : "Ops team email"} /></label>
          {mode === "admin" && (
            <label className="block text-sm">Scope
              <Select className="mt-1" value={destOrgScope} onChange={(event) => setDestOrgScope(event.target.value as typeof destOrgScope)}>
                <option value="PLATFORM">Platform-wide</option>
                <option value="ORGANIZATION">Specific organization</option>
              </Select>
            </label>
          )}
          {mode === "admin" && destOrgScope === "ORGANIZATION" && (
            <label className="block text-sm">Organization
              <Select className="mt-1" value={destClientAccountId} onChange={(event) => setDestClientAccountId(event.target.value)}>
                <option value="">Select an organization…</option>
                {clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
              </Select>
            </label>
          )}
          {destType === "WEBHOOK" ? (
            <>
              <label className="block text-sm">URL<Input type="url" className="mt-1" value={destUrl} onChange={(event) => setDestUrl(event.target.value)} placeholder="https://hooks.example.com/…" /></label>
              <label className="block text-sm">Authorization header value (optional)<Input type="password" autoComplete="new-password" className="mt-1" value={destAuthHeader} onChange={(event) => setDestAuthHeader(event.target.value)} placeholder="Bearer …" /></label>
              <label className="block text-sm">HMAC signing secret<Input type="password" autoComplete="new-password" className="mt-1" value={destSigningSecret} onChange={(event) => setDestSigningSecret(event.target.value)} minLength={16} placeholder="At least 16 characters" /></label>
              <p className="text-xs text-muted">Private/RFC1918 webhook destinations are disabled by default. Operators may explicitly enable them with WEBHOOK_ALLOW_PRIVATE_NETWORKS when an internal receiver is intentional; link-local/cloud metadata remains blocked.</p>
            </>
          ) : (
            <label className="block text-sm">Recipients (comma or newline separated)
              <textarea
                className="mt-1 min-h-20 w-full rounded-control border border-border bg-surface-raised px-3 py-2 text-sm text-text shadow-inner shadow-black/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30"
                value={destEmails}
                onChange={(event) => setDestEmails(event.target.value)}
                placeholder="ops@example.com, oncall@example.com"
              />
            </label>
          )}
        </div>
      </Modal>

      {/* ---- Create rule ---- */}
      <Modal
        open={createRuleOpen}
        onClose={() => setCreateRuleOpen(false)}
        title="Add rule"
        description="A rule decides what triggers a notification and where it goes; the destination itself only decides how."
        footer={<>
          <Button variant="secondary" onClick={() => setCreateRuleOpen(false)}>Cancel</Button>
          <Button onClick={() => createRule.mutate()} disabled={createRule.isPending || !ruleValid}>Create</Button>
        </>}
      >
        <div className="space-y-3">
          <label className="block text-sm">Name<Input className="mt-1" value={ruleName} onChange={(event) => setRuleName(event.target.value)} maxLength={100} placeholder="Critical infra alerts" /></label>
          {mode === "admin" && (
            <label className="block text-sm">Scope
              <Select className="mt-1" value={ruleScope} onChange={(event) => { setRuleScope(event.target.value as RuleScope); setRuleDestinationId(""); }}>
                <option value="PLATFORM">Whole platform</option>
                <option value="ORGANIZATION">Specific organization</option>
              </Select>
            </label>
          )}
          {mode === "admin" && ruleScope === "ORGANIZATION" && (
            <label className="block text-sm">Organization
              <Select className="mt-1" value={ruleClientAccountId} onChange={(event) => { setRuleClientAccountId(event.target.value); setRuleDestinationId(""); }}>
                <option value="">Select an organization…</option>
                {clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
              </Select>
            </label>
          )}
          <label className="block text-sm">Minimum severity
            <Select className="mt-1" value={ruleMinSeverity} onChange={(event) => setRuleMinSeverity(event.target.value as Severity)}>
              <option value="INFO">Info</option>
              <option value="WARNING">Warning</option>
              <option value="CRITICAL">Critical</option>
            </Select>
          </label>
          <label className="block text-sm">Destination
            <Select className="mt-1" value={ruleDestinationId} onChange={(event) => setRuleDestinationId(event.target.value)} disabled={eligibleRuleDestinations.length === 0}>
              <option value="">Select a destination…</option>
              {eligibleRuleDestinations.map((destination) => <option key={destination.id} value={destination.id}>{destination.name} ({destination.type === "EMAIL" ? "email" : "webhook"})</option>)}
            </Select>
          </label>
          {eligibleRuleDestinations.length === 0 && <p className="text-xs text-muted">No destination matches this scope yet. {mode === "admin" ? "Create a destination with the same scope first." : "Create a destination first."}</p>}
          <fieldset>
            <legend className="text-sm">Events</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {RULE_EVENT_OPTIONS.map((value) => (
                <label key={value} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={ruleEventTypes.includes(value)}
                    onChange={(event) => setRuleEventTypes(event.target.checked ? [...ruleEventTypes, value] : ruleEventTypes.filter((item) => item !== value))}
                    className="accent-accent"
                  />
                  {EVENT_LABEL[value]}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => {
          if (!confirmDelete) return;
          if (confirmDelete.kind === "destination") deleteDestination.mutate(confirmDelete.id);
          else deleteRule.mutate(confirmDelete.id);
        }}
        title={`Delete ${confirmDelete?.kind ?? "item"}`}
        impact={confirmDelete?.kind === "destination"
          ? `"${confirmDelete.name}" will stop receiving notifications. Any rule routing to it will also be removed.`
          : `"${confirmDelete?.name}" will stop routing events to its destination.`}
        confirmLabel="Delete"
      />
    </div>
  );
}
