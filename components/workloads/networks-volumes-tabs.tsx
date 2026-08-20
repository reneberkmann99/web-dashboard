"use client";

import { useQuery } from "@tanstack/react-query";
import { Network, HardDrive, FolderOpen, Layers } from "lucide-react";
import { apiFetch } from "@/lib/fetcher";
import { Badge } from "@/components/ui/badge";

export type SharedResourceStatus =
  | { kind: "exclusive" }
  | { kind: "shared_within_workload" }
  | { kind: "shared_with_others"; otherContainerCount: number };

type WorkloadNetworkView = {
  name: string;
  id: string;
  driver: string;
  scope: string;
  internal: boolean;
  subnets: string[];
  gateways: string[];
  workloadContainers: string[];
  totalAttachedCount: number;
  shared: SharedResourceStatus;
};

type WorkloadVolumeMountView =
  | {
      kind: "volume";
      volumeName: string;
      driver: string | null;
      destination: string;
      mode: string;
      workloadContainers: string[];
      shared: SharedResourceStatus;
    }
  | {
      kind: "bind";
      sourcePath: string | null;
      sourceHidden: boolean;
      destination: string;
      mode: string;
      container: string;
    }
  | {
      kind: "tmpfs";
      destination: string;
      container: string;
    };

type ResourcesPayload = { networks: WorkloadNetworkView[]; volumes: WorkloadVolumeMountView[] };

function SharedBadge({ status }: { status: SharedResourceStatus }): React.JSX.Element {
  if (status.kind === "exclusive") {
    return <Badge variant="default">Exclusive to this workload</Badge>;
  }
  if (status.kind === "shared_with_others") {
    return (
      <Badge variant="warning">
        Shared with {status.otherContainerCount} other container{status.otherContainerCount === 1 ? "" : "s"}
      </Badge>
    );
  }
  return <Badge variant="default">Shared within workload</Badge>;
}

/**
 * Read-only Networks + Volumes tabs for workload detail (admin and client).
 * No create/delete/disconnect actions — Phase 4 is adoption/visibility only.
 */
export function WorkloadNetworksTab({ resourcesUrl }: { resourcesUrl: string }): React.JSX.Element {
  const query = useQuery({
    queryKey: ["workload-resources", resourcesUrl],
    queryFn: () => apiFetch<ResourcesPayload>(resourcesUrl)
  });

  if (query.isLoading) {
    return (
      <div className="space-y-3" aria-busy="true" aria-label="Loading networks">
        <div className="h-16 animate-pulse rounded-lg bg-panelAlt" />
        <div className="h-16 animate-pulse rounded-lg bg-panelAlt" />
      </div>
    );
  }
  if (query.isError) {
    return <p className="text-sm text-critical-foreground">Failed to load networks.</p>;
  }
  const networks = query.data?.networks ?? [];
  if (networks.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-panelAlt/50 p-8 text-center">
        <Network className="mx-auto mb-2 h-6 w-6 text-muted" />
        <p className="font-medium">No networks reported</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted">
          This workload's containers aren't attached to any Docker network the agent could inspect.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {networks.map((n) => (
        <div key={n.name} className="rounded-lg border border-border bg-panel p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="flex items-center gap-2">
              <Network className="h-4 w-4 text-accent" />
              <span className="font-medium">{n.name}</span>
              {n.internal && <Badge>internal</Badge>}
            </div>
            <SharedBadge status={n.shared} />
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted">Driver</dt>
              <dd className="mt-0.5">{n.driver || "—"}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted">Scope</dt>
              <dd className="mt-0.5">{n.scope || "—"}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted">Subnet(s)</dt>
              <dd className="mt-0.5">{n.subnets.length > 0 ? n.subnets.join(", ") : "—"}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted">Gateway(s)</dt>
              <dd className="mt-0.5">{n.gateways.length > 0 ? n.gateways.join(", ") : "—"}</dd>
            </div>
          </dl>
          <div className="mt-3">
            <p className="mb-1 text-xs uppercase tracking-wide text-muted">
              Workload containers ({n.workloadContainers.length})
              {n.totalAttachedCount > n.workloadContainers.length && (
                <span className="ml-1 text-muted/70">
                  +{n.totalAttachedCount - n.workloadContainers.length} other
                </span>
              )}
            </p>
            <div className="flex flex-wrap gap-1">
              {n.workloadContainers.map((c) => (
                <Badge key={c}>{c}</Badge>
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function WorkloadVolumesTab({ resourcesUrl }: { resourcesUrl: string }): React.JSX.Element {
  const query = useQuery({
    queryKey: ["workload-resources", resourcesUrl],
    queryFn: () => apiFetch<ResourcesPayload>(resourcesUrl)
  });

  if (query.isLoading) {
    return (
      <div className="space-y-3" aria-busy="true" aria-label="Loading volumes">
        <div className="h-14 animate-pulse rounded-lg bg-panelAlt" />
        <div className="h-14 animate-pulse rounded-lg bg-panelAlt" />
      </div>
    );
  }
  if (query.isError) {
    return <p className="text-sm text-critical-foreground">Failed to load volumes.</p>;
  }
  const volumes = query.data?.volumes ?? [];
  if (volumes.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-panelAlt/50 p-8 text-center">
        <HardDrive className="mx-auto mb-2 h-6 w-6 text-muted" />
        <p className="font-medium">No persistent storage reported</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted">
          This workload's containers don't mount any named volumes, bind mounts, or tmpfs.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {volumes.map((v, i) => {
        if (v.kind === "volume") {
          return (
            <div key={`vol-${v.volumeName}`} className="rounded-lg border border-border bg-panel p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Layers className="h-4 w-4 text-accent" />
                  <span className="font-medium">{v.volumeName}</span>
                  <Badge>named volume</Badge>
                </div>
                <SharedBadge status={v.shared} />
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted">Driver</dt>
                  <dd className="mt-0.5">{v.driver ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted">Destination</dt>
                  <dd className="mt-0.5 font-mono text-xs">{v.destination}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted">Mode</dt>
                  <dd className="mt-0.5">{v.mode || "—"}</dd>
                </div>
              </dl>
              <div className="mt-3">
                <p className="mb-1 text-xs uppercase tracking-wide text-muted">
                  Mounted by ({v.workloadContainers.length})
                </p>
                <div className="flex flex-wrap gap-1">
                  {v.workloadContainers.map((c) => (
                    <Badge key={c}>{c}</Badge>
                  ))}
                </div>
              </div>
            </div>
          );
        }
        if (v.kind === "bind") {
          return (
            <div key={`bind-${i}-${v.destination}`} className="rounded-lg border border-border bg-panel p-4">
              <div className="flex items-center gap-2">
                <FolderOpen className="h-4 w-4 text-accent" />
                <Badge>bind mount</Badge>
                <span className="text-sm text-muted">{v.container}</span>
              </div>
              <dl className="mt-3 grid grid-cols-1 gap-3 text-sm md:grid-cols-3">
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted">Host path</dt>
                  <dd className="mt-0.5 font-mono text-xs">
                    {v.sourceHidden ? (
                      <span className="text-muted" title="Host filesystem paths are only visible to administrators">
                        Host path hidden
                      </span>
                    ) : (
                      v.sourcePath ?? "—"
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted">Destination</dt>
                  <dd className="mt-0.5 font-mono text-xs">{v.destination}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted">Mode</dt>
                  <dd className="mt-0.5">{v.mode === "ro" || v.mode === "readonly" ? "read-only" : v.mode || "read-write"}</dd>
                </div>
              </dl>
            </div>
          );
        }
        return (
          <div key={`tmpfs-${i}-${v.destination}`} className="rounded-lg border border-border bg-panel p-4">
            <div className="flex items-center gap-2">
              <Badge>tmpfs</Badge>
              <span className="text-sm text-muted">{v.container}</span>
              <span className="font-mono text-xs text-muted">{v.destination}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
