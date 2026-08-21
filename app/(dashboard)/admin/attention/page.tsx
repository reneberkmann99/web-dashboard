"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellOff, CalendarClock, Check, ExternalLink, ShieldAlert, X } from "lucide-react";
import { toast } from "sonner";
import { apiFetch } from "@/lib/fetcher";
import { AttentionBadge } from "@/components/ui/attention-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Pagination } from "@/components/ui/pagination";
import { timeAgo } from "@/lib/format";
import { PageHeader } from "@/components/ui/page-header";

type Actor = { displayName: string; email: string } | null;
type Acknowledgement = {
  id: string;
  acknowledgedAt: string;
  note: string | null;
  acknowledgedBy: Actor;
  clearedAt: string | null;
};
type LifecycleEntry = {
  id: string;
  scope: string;
  startsAt?: string;
  endsAt: string;
  reason: string | null;
  createdBy: Actor;
};
type Condition = {
  id: string;
  severity: "CRITICAL" | "WARNING" | "INFO";
  resourceType: string;
  resourceId: string;
  conditionType: string;
  title: string;
  detail: string;
  firstObservedAt: string;
  lastObservedAt: string;
  resolvedAt: string | null;
  acknowledgement: Acknowledgement | null;
  activeSilences: LifecycleEntry[];
  activeMaintenance: LifecycleEntry[];
  notificationsSuppressed: boolean;
  nodeId: string | null;
  workloadId: string | null;
};
type Detail = Condition & {
  acknowledgements: Acknowledgement[];
  silences: Array<LifecycleEntry & { cancelledAt: string | null }>;
  lifecycle: {
    activeSilences: LifecycleEntry[];
    activeMaintenance: LifecycleEntry[];
    notificationsSuppressed: boolean;
  };
  recentActivity: Array<{ id: string; action: string; actorEmail: string | null; result: string; createdAt: string }>;
};
type RefPayload = {
  nodes: Array<{ id: string; name: string }>;
  workloads: Array<{ id: string; name: string }>;
};
type MaintenanceWindow = {
  id: string;
  scope: "NODE" | "WORKLOAD";
  startsAt: string;
  endsAt: string;
  reason: string | null;
  notificationBehavior: "SUPPRESS" | "KEEP";
  node: { id: string; name: string } | null;
  workload: { id: string; name: string } | null;
  createdBy: Actor;
};

const tabs = [
  ["active", "Active"],
  ["acknowledged", "Acknowledged"],
  ["silenced", "Silenced"],
  ["resolved", "Resolved history"]
] as const;

function localDate(value: string): string {
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function datetimeLocalValue(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function actorName(actor: Actor): string {
  return actor?.displayName || actor?.email || "Unknown administrator";
}

export default function AttentionPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const [view, setView] = useState<(typeof tabs)[number][0]>("active");
  const [severity, setSeverity] = useState("");
  const [conditionType, setConditionType] = useState("");
  const [nodeId, setNodeId] = useState("");
  const [workloadId, setWorkloadId] = useState("");
  const [maintenanceFilter, setMaintenanceFilter] = useState(searchParams.get("maintenance") ?? "");
  const [selectedId, setSelectedId] = useState<string | null>(searchParams.get("conditionId"));
  const [ackOpen, setAckOpen] = useState(false);
  const [ackNote, setAckNote] = useState("");
  const [silenceOpen, setSilenceOpen] = useState(false);
  const [silenceDuration, setSilenceDuration] = useState("60");
  const [silenceReason, setSilenceReason] = useState("");
  const [silenceCustomEnd, setSilenceCustomEnd] = useState("");
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);
  const [maintenanceScope, setMaintenanceScope] = useState<"NODE" | "WORKLOAD">("NODE");
  const [maintenanceResourceId, setMaintenanceResourceId] = useState("");
  const [maintenanceStart, setMaintenanceStart] = useState("");
  const [maintenanceEnd, setMaintenanceEnd] = useState("");
  const [maintenanceReason, setMaintenanceReason] = useState("");
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 15;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const params = new URLSearchParams({ view });
  if (severity) params.set("severity", severity);
  if (conditionType) params.set("conditionType", conditionType);
  if (nodeId) params.set("nodeId", nodeId);
  if (workloadId) params.set("workloadId", workloadId);
  if (maintenanceFilter) params.set("maintenance", maintenanceFilter);

  const conditionsQuery = useQuery({
    queryKey: ["attention-center", view, severity, conditionType, nodeId, workloadId, maintenanceFilter],
    queryFn: () => apiFetch<{ conditions: Condition[] }>(`/api/admin/attention?${params.toString()}`),
    refetchInterval: 15_000
  });
  const refsQuery = useQuery({
    queryKey: ["admin-attention-refs"],
    queryFn: () => apiFetch<RefPayload>("/api/admin/clients-refs")
  });
  const maintenanceQuery = useQuery({
    queryKey: ["maintenance-windows"],
    queryFn: () => apiFetch<{ windows: MaintenanceWindow[] }>("/api/admin/maintenance"),
    refetchInterval: 30_000
  });
  const detailQuery = useQuery({
    queryKey: ["attention-detail", selectedId],
    queryFn: () => apiFetch<Detail>(`/api/admin/attention/${selectedId}`),
    enabled: Boolean(selectedId)
  });
  const conditions = conditionsQuery.data?.conditions ?? [];
  const conditionTypes = useMemo(() => Array.from(new Set(conditions.map((item) => item.conditionType))).sort(), [conditions]);

  const refresh = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["attention-center"] }),
      queryClient.invalidateQueries({ queryKey: ["attention-detail"] }),
      queryClient.invalidateQueries({ queryKey: ["admin-overview"] }),
      queryClient.invalidateQueries({ queryKey: ["maintenance-windows"] })
    ]);
  };

  const acknowledge = useMutation({
    mutationFn: () => apiFetch(`/api/admin/attention/${selectedId}/acknowledgement`, {
      method: "POST",
      body: JSON.stringify({ note: ackNote || null })
    }),
    onSuccess: async () => { setAckOpen(false); setAckNote(""); toast.success("Issue acknowledged"); await refresh(); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not acknowledge issue")
  });
  const unacknowledge = useMutation({
    mutationFn: () => apiFetch(`/api/admin/attention/${selectedId}/acknowledgement`, { method: "DELETE" }),
    onSuccess: async () => { toast.success("Acknowledgement removed"); await refresh(); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not remove acknowledgement")
  });
  const silence = useMutation({
    mutationFn: () => {
      const now = new Date();
      let endsAt: Date;
      if (silenceDuration === "custom") endsAt = new Date(silenceCustomEnd);
      else if (silenceDuration === "tomorrow") {
        endsAt = new Date(now);
        endsAt.setDate(endsAt.getDate() + 1);
        endsAt.setHours(9, 0, 0, 0);
      } else endsAt = new Date(now.getTime() + Number(silenceDuration) * 60_000);
      return apiFetch("/api/admin/silences", {
        method: "POST",
        body: JSON.stringify({
          scope: "CONDITION",
          attentionStateId: selectedId,
          startsAt: now.toISOString(),
          endsAt: endsAt.toISOString(),
          reason: silenceReason || null
        })
      });
    },
    onSuccess: async () => { setSilenceOpen(false); setSilenceReason(""); toast.success("Notifications silenced"); await refresh(); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not silence notifications")
  });
  const schedule = useMutation({
    mutationFn: () => apiFetch("/api/admin/maintenance", {
      method: "POST",
      body: JSON.stringify({
        scope: maintenanceScope,
        nodeId: maintenanceScope === "NODE" ? maintenanceResourceId : null,
        workloadId: maintenanceScope === "WORKLOAD" ? maintenanceResourceId : null,
        startsAt: new Date(maintenanceStart || Date.now()).toISOString(),
        endsAt: new Date(maintenanceEnd).toISOString(),
        reason: maintenanceReason || null,
        notificationBehavior: "SUPPRESS"
      })
    }),
    onSuccess: async () => { setMaintenanceOpen(false); toast.success("Maintenance scheduled"); await refresh(); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not schedule maintenance")
  });
  const cancelMaintenance = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/admin/maintenance/${id}`, { method: "DELETE" }),
    onSuccess: async () => { toast.success("Maintenance cancelled"); await refresh(); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not cancel maintenance")
  });

  const detail = detailQuery.data;
  const maintenanceWindows = maintenanceQuery.data?.windows ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Operations"
        title="Attention"
        description="Operational truth, acknowledgement, silence and maintenance — kept as separate states."
        actions={<Button onClick={() => {
          const now = new Date();
          const end = new Date(now.getTime() + 60 * 60_000);
          setMaintenanceStart(datetimeLocalValue(now));
          setMaintenanceEnd(datetimeLocalValue(end));
          setMaintenanceResourceId(refsQuery.data?.nodes[0]?.id ?? "");
          setMaintenanceOpen(true);
        }}>
          <CalendarClock className="mr-2 h-4 w-4" /> Schedule maintenance
        </Button>}
      />

      <div className="flex flex-wrap gap-2 border-b border-border pb-3">
        {tabs.map(([key, label]) => (
          <button key={key} type="button" onClick={() => setView(key)} className={`rounded-md px-3 py-1.5 text-sm ${view === key ? "bg-brand text-brand-contrast" : "bg-panelAlt text-muted hover:text-text"}`}>
            {label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <Select value={severity} onChange={(event) => { setSeverity(event.target.value); setPage(0); }} className="w-auto min-w-36">
          <option value="">All severities</option><option value="CRITICAL">Critical</option><option value="WARNING">Warning</option><option value="INFO">Info</option>
        </Select>
        <Select value={conditionType} onChange={(event) => { setConditionType(event.target.value); setPage(0); }} className="w-auto min-w-44">
          <option value="">All condition types</option>{conditionTypes.map((type) => <option key={type} value={type}>{type}</option>)}
        </Select>
        <Select value={nodeId} onChange={(event) => { setNodeId(event.target.value); setPage(0); }} className="w-auto min-w-40">
          <option value="">All nodes</option>{(refsQuery.data?.nodes ?? []).map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}
        </Select>
        <Select value={workloadId} onChange={(event) => { setWorkloadId(event.target.value); setPage(0); }} className="w-auto min-w-44">
          <option value="">All workloads</option>{(refsQuery.data?.workloads ?? []).map((workload) => <option key={workload.id} value={workload.id}>{workload.name}</option>)}
        </Select>
        <Select value={maintenanceFilter} onChange={(event) => { setMaintenanceFilter(event.target.value); setPage(0); }} className="w-auto min-w-44">
          <option value="">Any maintenance state</option><option value="active">Under maintenance</option><option value="none">Not under maintenance</option>
        </Select>
      </div>

      <section className="space-y-2" aria-label={`${view} attention conditions`}>
        {conditionsQuery.isLoading && <div className="h-24 animate-pulse rounded-lg bg-panelAlt" />}
        {conditionsQuery.isError && <p className="rounded-lg border border-critical/30 bg-critical/5 p-4 text-critical-foreground">Failed to load attention conditions.</p>}
        {!conditionsQuery.isLoading && conditions.length === 0 && <p className="rounded-lg border border-border bg-panelAlt/40 p-5 text-sm text-muted">No conditions match these filters.</p>}
        {conditions.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((condition) => (
          <button key={condition.id} type="button" onClick={() => setSelectedId(condition.id)} className={`w-full rounded-lg border p-4 text-left transition hover:border-accent/50 ${condition.resolvedAt ? "border-border bg-panelAlt/30 opacity-75" : condition.severity === "CRITICAL" ? "border-danger/30 bg-danger/5" : "border-warning/30 bg-warning/5"}`}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <AttentionBadge severity={condition.severity.toLowerCase() as "critical" | "warning" | "info"} />
                  <span className="text-xs text-muted">{condition.conditionType}</span>
                  {condition.activeMaintenance.length > 0 && <Badge variant="warning">maintenance</Badge>}
                  {condition.notificationsSuppressed && <Badge>notifications silenced</Badge>}
                </div>
                <p className="mt-2 font-medium">{condition.title}</p>
                <p className="mt-0.5 text-sm text-muted">{condition.detail}</p>
                <div className="mt-2 space-y-1 text-xs text-muted">
                  <p>{condition.resolvedAt ? `Resolved ${localDate(condition.resolvedAt)}` : `First observed ${timeAgo(condition.firstObservedAt)}`}</p>
                  {condition.acknowledgement && <p className="text-info-foreground">Acknowledged by {actorName(condition.acknowledgement.acknowledgedBy)} · {localDate(condition.acknowledgement.acknowledgedAt)}</p>}
                  {condition.activeSilences[0] && <p>Notifications silenced until {localDate(condition.activeSilences[0].endsAt)}</p>}
                </div>
              </div>
              <ExternalLink className="h-4 w-4 shrink-0 text-muted" />
            </div>
          </button>
        ))}
      </section>

      {conditions.length > PAGE_SIZE && (
        <Pagination
          start={page * PAGE_SIZE + 1}
          end={Math.min((page + 1) * PAGE_SIZE, conditions.length)}
          total={conditions.length}
          page={page + 1}
          pageCount={Math.ceil(conditions.length / PAGE_SIZE)}
          onPageChange={(p) => setPage(p - 1)}
        />
      )}

      {maintenanceWindows.length > 0 && (
        <section>
          <h2 className="mb-2 text-lg font-semibold">Upcoming and active maintenance</h2>
          <div className="space-y-2">
            {maintenanceWindows.map((window) => {
              const active = new Date(window.startsAt) <= new Date();
              return <div key={window.id} className="flex items-start justify-between gap-3 rounded-lg border border-warning/30 bg-warning/5 p-3">
                <div>
                  <div className="flex items-center gap-2"><Badge variant="warning">{active ? "maintenance" : "upcoming"}</Badge><span className="font-medium">{window.node?.name ?? window.workload?.name}</span></div>
                  <p className="mt-1 text-sm text-muted">{localDate(window.startsAt)}–{localDate(window.endsAt)} · {window.reason || "No reason supplied"}</p>
                  <p className="text-xs text-muted">Created by {actorName(window.createdBy)} · operational notifications {window.notificationBehavior === "SUPPRESS" ? "suppressed" : "kept"}</p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => cancelMaintenance.mutate(window.id)}><X className="mr-1 h-3 w-3" /> Cancel</Button>
              </div>;
            })}
          </div>
        </section>
      )}

      <Modal open={Boolean(selectedId)} onClose={() => setSelectedId(null)} title={detail?.title ?? "Issue detail"} description={detail?.conditionType} size="lg">
        {!detail ? <div className="h-40 animate-pulse rounded bg-panelAlt" /> : <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <AttentionBadge severity={detail.severity.toLowerCase() as "critical" | "warning" | "info"} />
            <Badge>{detail.resourceType.toLowerCase()}</Badge>
            {detail.lifecycle.activeMaintenance.length > 0 && <Badge variant="warning">maintenance</Badge>}
            {detail.lifecycle.notificationsSuppressed && <Badge>notifications silenced</Badge>}
          </div>
          <div><p className="text-sm">{detail.detail}</p><p className="mt-2 text-xs text-muted">First observed {localDate(detail.firstObservedAt)} · last observed {localDate(detail.lastObservedAt)}</p></div>
          {detail.acknowledgement ? <div className="rounded-lg border border-accent/30 bg-accent/5 p-3 text-sm"><p className="font-medium"><Check className="mr-1 inline h-4 w-4" />Acknowledged by {actorName(detail.acknowledgement.acknowledgedBy)}</p><p className="text-xs text-muted">{localDate(detail.acknowledgement.acknowledgedAt)}</p>{detail.acknowledgement.note && <p className="mt-2">{detail.acknowledgement.note}</p>}</div> : null}
          {detail.lifecycle.activeSilences.map((item) => <div key={item.id} className="rounded-lg border border-border bg-panelAlt/50 p-3 text-sm"><BellOff className="mr-1 inline h-4 w-4" />Notifications silenced until {localDate(item.endsAt)} by {actorName(item.createdBy)}{item.reason ? ` — ${item.reason}` : ""}</div>)}
          {detail.lifecycle.activeMaintenance.map((item) => <div key={item.id} className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm"><CalendarClock className="mr-1 inline h-4 w-4" />Maintenance until {localDate(item.endsAt)}{item.reason ? ` — ${item.reason}` : ""}</div>)}
          {!detail.resolvedAt && <div className="flex flex-wrap gap-2">
            {detail.acknowledgement ? <Button variant="secondary" onClick={() => unacknowledge.mutate()}>Unacknowledge</Button> : <Button onClick={() => setAckOpen(true)}>Acknowledge</Button>}
            <Button variant="secondary" onClick={() => setSilenceOpen(true)}><BellOff className="mr-2 h-4 w-4" />Silence</Button>
            {detail.nodeId && <Link href={detail.resourceType === "NODE" ? `/admin/nodes/${detail.resourceId}` : detail.workloadId ? `/admin/workloads/${detail.workloadId}` : `/admin/containers?nodeId=${detail.nodeId}`} className="inline-flex h-10 items-center rounded-md bg-panelAlt px-4 text-sm">View resource</Link>}
          </div>}
          <div><h3 className="mb-2 font-medium">Recent relevant activity</h3><div className="max-h-48 space-y-1 overflow-y-auto">{detail.recentActivity.map((event) => <div key={event.id} className="flex justify-between gap-3 border-b border-border py-2 text-xs"><span>{event.action.replaceAll("_", " ").toLowerCase()} {event.actorEmail ? `by ${event.actorEmail}` : ""}</span><span className="shrink-0 text-muted">{localDate(event.createdAt)}</span></div>)}</div></div>
        </div>}
      </Modal>

      <Modal open={ackOpen} onClose={() => setAckOpen(false)} title="Acknowledge issue" footer={<><Button variant="secondary" onClick={() => setAckOpen(false)}>Cancel</Button><Button onClick={() => acknowledge.mutate()} disabled={acknowledge.isPending}>Acknowledge</Button></>}>
        <label className="text-sm">Optional note<Textarea className="mt-2" value={ackNote} onChange={(event) => setAckNote(event.target.value)} maxLength={1000} placeholder="Investigating upstream DNS issue" /></label>
      </Modal>

      <Modal open={silenceOpen} onClose={() => setSilenceOpen(false)} title="Silence notifications" description="The issue remains visible and operational severity does not change." footer={<><Button variant="secondary" onClick={() => setSilenceOpen(false)}>Cancel</Button><Button onClick={() => silence.mutate()} disabled={silence.isPending || (silenceDuration === "custom" && !silenceCustomEnd)}>Silence</Button></>}>
        <div className="space-y-3"><label className="block text-sm">Duration<Select className="mt-1" value={silenceDuration} onChange={(event) => setSilenceDuration(event.target.value)}><option value="30">30 minutes</option><option value="60">1 hour</option><option value="240">4 hours</option><option value="tomorrow">Until tomorrow 09:00</option><option value="custom">Custom</option></Select></label>{silenceDuration === "custom" && <label className="block text-sm">Ends ({timeZone})<Input type="datetime-local" className="mt-1" value={silenceCustomEnd} onChange={(event) => setSilenceCustomEnd(event.target.value)} /></label>}<label className="block text-sm">Reason (optional)<Textarea className="mt-1" value={silenceReason} onChange={(event) => setSilenceReason(event.target.value)} maxLength={1000} /></label></div>
      </Modal>

      <Modal open={maintenanceOpen} onClose={() => setMaintenanceOpen(false)} title="Schedule maintenance" description={`Times are shown in ${timeZone}. No containers will be stopped.`} footer={<><Button variant="secondary" onClick={() => setMaintenanceOpen(false)}>Cancel</Button><Button onClick={() => schedule.mutate()} disabled={schedule.isPending || !maintenanceResourceId || !maintenanceEnd}>Schedule</Button></>}>
        <div className="space-y-3"><label className="block text-sm">Resource type<Select className="mt-1" value={maintenanceScope} onChange={(event) => { const scope = event.target.value as "NODE" | "WORKLOAD"; setMaintenanceScope(scope); setMaintenanceResourceId(scope === "NODE" ? refsQuery.data?.nodes[0]?.id ?? "" : refsQuery.data?.workloads[0]?.id ?? ""); }}><option value="NODE">Node</option><option value="WORKLOAD">Workload</option></Select></label><label className="block text-sm">Resource<Select className="mt-1" value={maintenanceResourceId} onChange={(event) => setMaintenanceResourceId(event.target.value)}><option value="">Select resource</option>{(maintenanceScope === "NODE" ? refsQuery.data?.nodes ?? [] : refsQuery.data?.workloads ?? []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></label><div className="grid gap-3 sm:grid-cols-2"><label className="block text-sm">Starts<Input type="datetime-local" className="mt-1" value={maintenanceStart} onChange={(event) => setMaintenanceStart(event.target.value)} /></label><label className="block text-sm">Ends<Input type="datetime-local" className="mt-1" value={maintenanceEnd} onChange={(event) => setMaintenanceEnd(event.target.value)} /></label></div><label className="block text-sm">Reason<Textarea className="mt-1" value={maintenanceReason} onChange={(event) => setMaintenanceReason(event.target.value)} maxLength={1000} placeholder="Kernel update" /></label><p className="text-xs text-muted">Behavior: suppress operational notifications. Underlying health remains truthful.</p></div>
      </Modal>
    </div>
  );
}
