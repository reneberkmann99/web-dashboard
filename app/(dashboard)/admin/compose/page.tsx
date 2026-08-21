"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Boxes, Layers, HardDrive, AlertTriangle, Check, ArrowLeft, ArrowRight, X } from "lucide-react";
import { apiFetch } from "@/lib/fetcher";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { DataTable, type Column } from "@/components/ui/data-table";
import { timeAgo } from "@/lib/format";
import { PageHeader } from "@/components/ui/page-header";

type DiscoveredProject = {
  nodeId: string;
  nodeName: string;
  composeProject: string;
  containerCount: number;
  runningCount: number;
  healthSummary: "healthy" | "degraded" | "down" | "unknown";
  serviceNames: string[];
  networkCount: number;
  volumeCount: number;
  hasConflict: boolean;
  lastObservedAt: string | null;
  adopted: boolean;
  workloadId: string | null;
  workloadName: string | null;
};

type DiscoveryPayload = { projects: DiscoveredProject[] };
type RefPayload = { clients: Array<{ id: string; name: string }> };
type DetailPayload = {
  project: {
    nodeId: string;
    nodeName: string;
    composeProject: string;
    services: Array<{ dockerContainerId: string; dockerName: string; composeService: string | null; status: string; image: string }>;
    runningCount: number;
    totalCount: number;
    healthSummary: string;
    networks: string[];
    volumes: string[];
    lastObservedAt: string | null;
    conflicts: Array<{ workloadId: string; workloadName: string; workloadSource: string; containerNames: string[] }>;
    adopted: boolean;
    workloadId: string | null;
    workloadName: string | null;
  };
};
type AdoptPayload = {
  id: string;
  definition?:
    | { status: "definition_created"; deploymentId: string; projectId: string; revisionId: string; serviceNames: string[] }
    | { status: "node_offline" | "no_containers" | "compose_unavailable" | "synthesis_failed" | "invalid"; detail?: string }
    | { status: "ack_required"; highRiskFindings?: Array<{ message: string }> };
};

function healthVariant(h: string): "success" | "warning" | "danger" | "default" {
  return h === "healthy" ? "success" : h === "degraded" ? "warning" : h === "down" ? "danger" : "default";
}

export default function ComposeDiscoveryPage(): React.JSX.Element {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<DiscoveredProject | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [step, setStep] = useState(1);
  const [name, setName] = useState("");
  const [clientId, setClientId] = useState("");
  const [moveConflicting, setMoveConflicting] = useState(false);
  const [detail, setDetail] = useState<DetailPayload["project"] | null>(null);

  const discovery = useQuery({
    queryKey: ["compose-discovery"],
    queryFn: () => apiFetch<DiscoveryPayload>("/api/admin/compose/discovered"),
    refetchInterval: 20000
  });
  const refs = useQuery({
    queryKey: ["compose-refs"],
    queryFn: () => apiFetch<RefPayload>("/api/admin/clients-refs")
  });

  const adoptMutation = useMutation({
    mutationFn: () =>
      apiFetch<AdoptPayload>("/api/admin/compose/adopt", {
        method: "POST",
        body: JSON.stringify({
          nodeId: selected?.nodeId,
          composeProject: selected?.composeProject,
          name: name.trim() || selected?.composeProject,
          clientAccountId: clientId || null,
          moveConflictingContainers: moveConflicting
        })
      }),
    onSuccess: (data) => {
      const definition = data.definition;
      if (definition && definition.status === "definition_created") {
        toast.success(`Workload adopted — ${definition.serviceNames.length} service(s) captured in the managed definition.`);
      } else if (definition && definition.status === "ack_required") {
        toast.success("Workload adopted — definition needs review (high-risk settings). Open the workload to acknowledge and create it.");
      } else if (definition && definition.status === "synthesis_failed") {
        toast.success(`Workload adopted — definition not captured (${definition.detail ?? "inspection failed"}). Open the workload to manage it.`);
      } else if (definition && (definition.status === "node_offline" || definition.status === "compose_unavailable")) {
        toast.success("Workload adopted — managed definition pending (node/Compose unavailable).");
      } else {
        toast.success("Workload adopted");
      }
      setWizardOpen(false);
      setSelected(null);
      queryClient.invalidateQueries({ queryKey: ["compose-discovery"] });
      queryClient.invalidateQueries({ queryKey: ["admin-workloads"] });
      router.push(`/admin/workloads/${data.id}`);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Adoption failed");
    }
  });

  // Load detail when a row is selected.
  const openDetail = useCallback(
    async (p: DiscoveredProject) => {
      setSelected(p);
      try {
        const payload = await apiFetch<DetailPayload>(
          `/api/admin/compose/discovered/${p.nodeId}/${encodeURIComponent(p.composeProject)}`
        );
        setDetail(payload.project);
        setStep(1);
        setName(payload.project.composeProject);
        setClientId("");
        setMoveConflicting(false);
        setWizardOpen(true);
      } catch {
        toast.error("Failed to load Compose project detail");
      }
    },
    []
  );

  const columns: Column<DiscoveredProject>[] = [
    {
      key: "name",
      header: "Compose project",
      sortValue: (p) => p.composeProject,
      render: (p) => (
        <div>
          <p className="font-medium">{p.composeProject}</p>
          <p className="text-xs text-muted">{p.nodeName}</p>
        </div>
      )
    },
    {
      key: "containers",
      header: "Containers",
      sortValue: (p) => p.containerCount,
      render: (p) => (
        <span className="text-sm">
          {p.runningCount}/{p.containerCount} running
        </span>
      )
    },
    {
      key: "services",
      header: "Services",
      hideBelow: "sm",
      render: (p) => (
        <div className="flex flex-wrap gap-1">
          {p.serviceNames.slice(0, 4).map((s) => (
            <Badge key={s}>{s}</Badge>
          ))}
          {p.serviceNames.length > 4 && <span className="text-xs text-muted">+{p.serviceNames.length - 4}</span>}
        </div>
      )
    },
    {
      key: "health",
      header: "Health",
      sortValue: (p) => p.healthSummary,
      render: (p) => <Badge variant={healthVariant(p.healthSummary)}>{p.healthSummary}</Badge>
    },
    {
      key: "topology",
      header: "Topology",
      hideBelow: "md",
      render: (p) => (
        <span className="inline-flex items-center gap-2 text-xs text-muted">
          <span className="inline-flex items-center gap-1"><Layers size={12} />{p.networkCount}</span>
          <span className="inline-flex items-center gap-1"><HardDrive size={12} />{p.volumeCount}</span>
        </span>
      )
    },
    {
      key: "conflict",
      header: "Status",
      render: (p) =>
        p.adopted ? (
          <Badge variant="default">Adopted: {p.workloadName ?? "—"}</Badge>
        ) : p.hasConflict ? (
          <Badge variant="warning"><AlertTriangle size={12} className="mr-1" />Container conflict</Badge>
        ) : (
          <Badge variant="success">Ready to adopt</Badge>
        )
    },
    {
      key: "observed",
      header: "Last observed",
      sortValue: (p) => p.lastObservedAt ?? "",
      hideBelow: "lg",
      render: (p) => <span className="text-xs text-muted">{timeAgo(p.lastObservedAt)}</span>
    },
    {
      key: "actions",
      header: "",
      render: (p) =>
        p.adopted ? (
          <Button size="sm" variant="secondary" onClick={() => p.workloadId && router.push(`/admin/workloads/${p.workloadId}`)}>
            Open workload
          </Button>
        ) : (
          <Button size="sm" onClick={() => void openDetail(p)}>
            Review & adopt
          </Button>
        )
    }
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Workload intake"
        title="Compose discovery"
        back={<button type="button" onClick={() => router.push("/admin/workloads")} className="mb-2 text-sm text-brand hover:text-brand-hover">← Workloads</button>}
        description={<span>Docker Compose projects detected on your nodes. Adopt one as a Noderaft workload — nothing is modified on the Docker side by discovery or adoption.</span>}
      />

      <DataTable
        columns={columns}
        rows={(discovery.data?.projects ?? []).filter((p) => !p.adopted)}
        searchableText={(p) => `${p.composeProject} ${p.nodeName} ${p.serviceNames.join(" ")}`}
        searchPlaceholder="Search Compose projects…"
        loading={discovery.isLoading}
        error={discovery.isError ? "Failed to load Compose projects" : null}
        emptyTitle="No Compose projects discovered"
        emptyBody="Containers carrying com.docker.compose.project labels on enrolled nodes will appear here."
        rowKey={(p) => `${p.nodeId}:${p.composeProject}`}
      />

      {adoptMutation.isError && (
        <p className="text-sm text-critical-foreground">{adoptMutation.error instanceof Error ? adoptMutation.error.message : "Adoption failed"}</p>
      )}

      {/* Adoption wizard */}
      <Modal
        open={wizardOpen && selected !== null}
        onClose={() => {
          setWizardOpen(false);
          setSelected(null);
          setDetail(null);
        }}
        title={`Adopt ${selected?.composeProject ?? "Compose project"}`}
        size="lg"
        footer={
          <div className="flex w-full items-center justify-between">
            <div className="flex items-center gap-1">
              {[1, 2, 3].map((s) => (
                <span key={s} className={`h-1.5 w-6 rounded-full ${step === s ? "bg-accent" : "bg-panelAlt"}`} />
              ))}
              <span className="ml-2 text-xs text-muted">Step {step} of 3</span>
            </div>
            <div className="flex gap-2">
              {step > 1 && (
                <Button variant="secondary" onClick={() => setStep((s) => s - 1)}>
                  <ArrowLeft size={14} className="mr-1" /> Back
                </Button>
              )}
              {step < 3 ? (
                <Button onClick={() => setStep((s) => s + 1)}>
                  Next <ArrowRight size={14} className="ml-1" />
                </Button>
              ) : (
                <Button
                  disabled={adoptMutation.isPending}
                  onClick={() => adoptMutation.mutate()}
                >
                  <Check size={14} className="mr-1" />
                  {adoptMutation.isPending ? "Adopting…" : "Adopt workload"}
                </Button>
              )}
            </div>
          </div>
        }
      >
        {detail && (
          <div className="space-y-4">
            {step === 1 && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
                  <Info label="Node" value={detail.nodeName} />
                  <Info label="Containers" value={`${detail.runningCount}/${detail.totalCount} running`} />
                  <Info label="Networks" value={String(detail.networks.length)} />
                  <Info label="Volumes" value={String(detail.volumes.length)} />
                </div>

                <div>
                  <p className="mb-1 text-xs uppercase tracking-wide text-muted">Detected services</p>
                  <div className="flex flex-wrap gap-1">
                    {detail.services.map((s) => (
                      <Badge key={s.dockerContainerId} variant={s.status === "running" ? "success" : s.status === "stopped" ? "default" : "warning"}>
                        {s.dockerName}
                      </Badge>
                    ))}
                  </div>
                </div>

                {detail.conflicts.length > 0 && (
                  <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm text-warning-foreground">
                    <p className="font-medium"><AlertTriangle size={14} className="mr-1 inline" /> Containers already in another workload</p>
                    {detail.conflicts.map((c) => (
                      <p key={c.workloadId} className="mt-1 text-xs">
                        {c.containerNames.length} of {detail.totalCount} containers are currently members of "
                        {c.workloadName}" ({c.workloadSource.toLowerCase()}).
                      </p>
                    ))}
                  </div>
                )}

                <div className="space-y-1">
                  <label htmlFor="compose-name" className="text-sm text-muted">Workload name</label>
                  <Input id="compose-name" value={name} onChange={(e) => setName(e.target.value)} />
                  <p className="text-xs text-muted">Defaulted from the Compose project name; editable.</p>
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="space-y-4">
                <p className="text-sm text-muted">Who should own this workload? You can always grant access to clients later via the workload's "Grant access" action.</p>
                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="radio" name="compose-owner" checked={clientId === ""} onChange={() => setClientId("")} className="accent-accent" />
                    No client / internal workload
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="radio" name="compose-owner" checked={clientId !== ""} onChange={() => setClientId(refs.data?.clients?.[0]?.id ?? "")} className="accent-accent" />
                    Assign to existing client
                  </label>
                  {clientId !== "" && (
                    <select
                      value={clientId}
                      onChange={(e) => setClientId(e.target.value)}
                      aria-label="Select client"
                      className="w-full rounded-md border border-border bg-panelAlt px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-accent"
                    >
                      {(refs.data?.clients ?? []).map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  )}
                </div>
                <p className="text-xs text-muted">
                  Assigning a client does not automatically grant permissions — use the existing access-grant system for that.
                </p>
              </div>
            )}

            {step === 3 && (
              <div className="space-y-4">
                <div className="rounded-lg border border-border bg-panelAlt p-3 text-sm">
                  <p className="font-medium">Noderaft will:</p>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
                    <li>create a <strong className="text-text">COMPOSE</strong> workload named "{name.trim() || detail.composeProject}"</li>
                    <li>associate the discovered Compose project "{detail.composeProject}" on {detail.nodeName}</li>
                    <li>track its services automatically</li>
                    <li>preserve association when containers are recreated</li>
                  </ul>
                </div>
                <div className="rounded-lg border border-border bg-panelAlt p-3 text-sm">
                  <p className="font-medium">Noderaft will NOT:</p>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
                    <li>restart containers</li>
                    <li>modify Docker Compose files</li>
                    <li>modify environment variables</li>
                    <li>create or remove Docker resources</li>
                  </ul>
                </div>

                {detail.conflicts.length > 0 && (
                  <label className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm text-warning-foreground">
                    <input
                      type="checkbox"
                      checked={moveConflicting}
                      onChange={(e) => setMoveConflicting(e.target.checked)}
                      className="mt-0.5 accent-accent"
                    />
                    <span>
                      I understand {detail.conflicts.reduce((n, c) => n + c.containerNames.length, 0)} container(s) will be
                      reassigned from their current workload into this new one.
                    </span>
                  </label>
                )}
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-panelAlt p-3">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 text-sm">{value}</p>
    </div>
  );
}
