"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetcher";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { timeAgo } from "@/lib/format";
import type { ReleaseDetailPayload, ReleaseListItem, ReleasesListPayload } from "./types";
import { RELEASE_HEALTH_LABELS } from "./labels";
import { Pagination } from "@/components/ui/pagination";

const PAGE_SIZE = 10;

/**
 * Release history timeline. Badges never rely on color alone: CURRENT,
 * LAST HEALTHY, HEALTHY, DEGRADED and the operation type are all spelled out.
 */
export function ReleaseHistory({
  deploymentId,
  apiBase = "/api/admin/deployments",
  onRollback,
  emptyState
}: {
  deploymentId: string;
  apiBase?: string;
  onRollback?: () => void;
  emptyState?: React.ReactNode;
}): React.JSX.Element {
  const [selected, setSelected] = useState<ReleaseListItem | null>(null);
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const page = Math.max(1, Number(searchParams.get("releasePage") ?? "1"));

  const query = useQuery({
    queryKey: ["deployment-release-history", apiBase, deploymentId, page],
    queryFn: () => apiFetch<ReleasesListPayload>(`${apiBase}/${deploymentId}/releases?limit=${PAGE_SIZE}&offset=${(page - 1) * PAGE_SIZE}`),
    refetchInterval: 15000
  });

  if (query.isLoading) {
    return <div className="h-40 animate-pulse rounded-lg bg-panelAlt" />;
  }
  if (query.isError || !query.data) {
    return <p className="text-sm text-critical-foreground">Failed to load release history.</p>;
  }
  if (query.data.total === 0) {
    return (
      <div className="rounded-lg border border-border bg-panel p-6 text-center text-sm text-muted">
        {emptyState ?? "This managed workload has not been deployed yet."}
      </div>
    );
  }

  return (
    <>
      <ol className="space-y-2">
        {query.data.data.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              onClick={() => setSelected(r)}
              className="w-full rounded-lg border border-border bg-panel p-3 text-left transition hover:border-accent/50"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">Release {r.displayNumber}</span>
                <Badge variant={r.healthVerdict === "HEALTHY" ? "success" : "warning"}>{RELEASE_HEALTH_LABELS[r.healthVerdict]}</Badge>
                <Badge variant="default">{r.operationType}</Badge>
                {r.isCurrent && <Badge variant="default">CURRENT</Badge>}
                {r.isLastHealthy && <Badge variant="success">LAST HEALTHY</Badge>}
                <span className="ml-auto text-xs text-muted">
                  Revision {r.revisionNumber} · {timeAgo(r.appliedAt)} {r.actorEmail ? `· ${r.actorEmail}` : ""}
                </span>
              </div>
              <p className="mt-1.5 text-sm text-muted">
                {r.sameRevisionAsPrevious
                  ? "Same configuration revision — secret rotation or redeploy."
                  : r.failureReason
                    ? `Configuration applied, but ${r.failureReason}.`
                    : r.operationType === "ROLLBACK"
                      ? "Rollback to a previous revision."
                      : "Configuration deployment."}
              </p>
              <p className="mt-1 truncate font-mono text-xs text-muted/70">
                {r.images.map((i) => i.imageRef).join(" · ") || "no image info"}
              </p>
            </button>
          </li>
        ))}
      </ol>
      {query.data.total > PAGE_SIZE && (
        <Pagination
          start={(page - 1) * PAGE_SIZE + 1}
          end={Math.min(page * PAGE_SIZE, query.data.total)}
          total={query.data.total}
          page={page}
          pageCount={Math.ceil(query.data.total / PAGE_SIZE)}
          onPageChange={(nextPage) => {
            const params = new URLSearchParams(searchParams.toString());
            if (nextPage <= 1) params.delete("releasePage");
            else params.set("releasePage", String(nextPage));
            const suffix = params.toString();
            router.push(suffix ? `${pathname}?${suffix}` : pathname, { scroll: false });
          }}
        />
      )}
      {selected && (
        <ReleaseDetailModal deploymentId={deploymentId} apiBase={apiBase} release={selected} onClose={() => setSelected(null)} onRollback={onRollback} />
      )}
    </>
  );
}

function ReleaseDetailModal({
  deploymentId,
  apiBase,
  release,
  onClose,
  onRollback
}: {
  deploymentId: string;
  apiBase: string;
  release: ReleaseListItem;
  onClose: () => void;
  onRollback?: () => void;
}): React.JSX.Element {
  const detail = useQuery({
    queryKey: ["deployment-release-detail", apiBase, deploymentId, release.id],
    queryFn: () => apiFetch<ReleaseDetailPayload>(`${apiBase}/${deploymentId}/releases/${release.id}`)
  });

  const d = detail.data ?? ({
    ...release,
    composeVersion: null,
    revisionCreatedAt: "",
    revisionCreatedBy: null,
    deployNote: null,
    deploymentId,
    composeProjectName: "",
    deploymentRuntimeState: "",
    operationResult: { verifyVerdict: null, runtimeConverged: null, health: null, planHash: null, applyError: null, cancelled: null, recovered: null },
    rotatedSecretKeys: [],
    previousRelease: null
  } as ReleaseDetailPayload);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
      <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-border bg-panel p-5">
        <div className="mb-3 flex items-start justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">Release {d.displayNumber}</h2>
            <Badge variant={d.healthVerdict === "HEALTHY" ? "success" : "warning"}>{RELEASE_HEALTH_LABELS[d.healthVerdict]}</Badge>
            <Badge variant="default">{d.operationType}</Badge>
            {d.isCurrent && <Badge variant="default">CURRENT</Badge>}
            {d.isLastHealthy && <Badge variant="success">LAST HEALTHY</Badge>}
          </div>
          <button type="button" onClick={onClose} className="text-muted hover:text-text" aria-label="Close">
            ✕
          </button>
        </div>

        {detail.isLoading && <p className="text-sm text-muted">Loading details…</p>}

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <Detail label="Release" value={`#${d.displayNumber}`} mono={false} />
          <Detail label="Revision" value={String(d.revisionNumber)} />
          <Detail label="Operation" value={`${d.operationType} (${d.operationState})`} />
          <Detail label="By" value={d.actorEmail ?? "—"} />
          <Detail label="Applied" value={d.appliedAt ? timeAgo(d.appliedAt) : "—"} />
          <Detail label="Compose" value={d.composeVersion ?? "—"} mono />
          <Detail label="Release ID" value={d.id} mono />
          <Detail label="Operation ID" value={d.operationId} mono />
        </dl>

        {d.rotatedSecretKeys.length > 0 && (
          <div className="mt-3 rounded border border-border bg-panelAlt p-3 text-sm">
            <p className="font-medium">Secret rotation release</p>
            <p className="mt-1 text-muted">
              Configuration revision did not change. Secret version{d.rotatedSecretKeys.length > 1 ? "s" : ""}{" "}
              <span className="font-mono">{d.rotatedSecretKeys.join(", ")}</span> {d.rotatedSecretKeys.length > 1 ? "were" : "was"} updated and
              the workload was reconciled. Secret values are never shown.
            </p>
          </div>
        )}

        {d.healthVerdict === "DEGRADED" && (
          <div className="mt-3 rounded border border-warning/40 bg-warning/10 p-3 text-sm">
            <p className="font-medium">Why is this release degraded?</p>
            <p className="mt-1 text-muted">
              The configuration was applied and the runtime converged to it, but health verification failed
              {d.failureReason ? `: ${d.failureReason}` : "."} {d.isCurrent ? "This is the current release." : "This is a historical release."}
            </p>
          </div>
        )}

        {d.operationResult.verifyVerdict && (
          <div className="mt-3 text-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Verification</p>
            <p className="mt-0.5">
              <span className="font-mono text-xs">{d.operationResult.verifyVerdict}</span>
              {d.operationResult.runtimeConverged !== null && (
                <span className="ml-2 text-muted">{d.operationResult.runtimeConverged ? "· runtime converged" : "· runtime did not converge"}</span>
              )}
            </p>
          </div>
        )}

        {d.images.length > 0 && (
          <div className="mt-3">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Runtime image identities (observed, not tags)</p>
            <ul className="space-y-1">
              {d.images.map((i) => (
                <li key={i.serviceName} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-mono">{i.serviceName}</span>
                  <span className="font-mono text-xs text-muted">{i.repoDigest ?? i.imageRef}</span>
                  {i.imageId && <span className="font-mono text-xs text-muted/70">{i.imageId.slice(0, 19)}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {d.secrets.length > 0 && (
          <div className="mt-3">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Secret versions at release time</p>
            <ul className="space-y-1 text-sm">
              {d.secrets.map((s) => (
                <li key={s.key}>
                  <span className="font-mono">{s.key}</span> <span className="text-muted">→ version {s.versionNumber}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          {onRollback && !d.isLastHealthy && (
            <Button size="sm" variant="warning" onClick={() => { onClose(); onRollback(); }}>
              Rollback
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}

function Detail({ label, value, mono = false }: { label: string; value: string; mono?: boolean }): React.JSX.Element {
  return (
    <div>
      <dt className="text-xs uppercase text-muted">{label}</dt>
      <dd className={mono ? "break-all font-mono text-xs" : "font-medium"}>{value}</dd>
    </div>
  );
}
