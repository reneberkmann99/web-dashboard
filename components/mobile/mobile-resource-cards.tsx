"use client";

import { Heart, Server } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ContainerView, WorkloadSummary, UserRecord } from "@/types/domain";
import { roleLabel } from "@/types/domain";
import { timeAgo } from "@/lib/format";
import {
  MobileResourceCard,
  CardChip,
  CardIconTile,
  CardMeter
} from "@/components/mobile/mobile-resource-card";

/**
 * Per-resource card renderers for the mobile card family (design §02/§06/
 * §16/§17/§19). One shell, domain-specific content. These are the `mobileCard`
 * presentations for DataTable/ServerDataTable and the Overview lists.
 */

/* ---------------------------- Containers ---------------------------- */

export function containerCard(
  container: ContainerView,
  onOpen?: () => void,
  onKeyDown?: (event: React.KeyboardEvent) => void
): React.JSX.Element {
  const stopped = container.status === "stopped";
  const statusChip =
    container.status === "running" ? (
      <CardChip tone="success" dot>running</CardChip>
    ) : container.status === "stopped" ? (
      container.expectedStopped ? (
        <CardChip tone="neutral">stopped intentionally</CardChip>
      ) : (
        <CardChip tone="danger" dot>stopped</CardChip>
      )
    ) : container.status === "restarting" ? (
      <CardChip tone="warning" dot>restarting</CardChip>
    ) : container.status === "unhealthy" ? (
      <CardChip tone="warning" dot>unhealthy</CardChip>
    ) : (
      <CardChip>unknown</CardChip>
    );

  const healthChip =
    container.health === "healthy" ? (
      <CardChip tone="success">healthy</CardChip>
    ) : container.health === "unhealthy" ? (
      <CardChip tone="danger">unhealthy</CardChip>
    ) : null;

  const dot =
    container.status === "running"
      ? "ok"
      : container.status === "stopped"
        ? "muted"
        : container.status === "restarting" || container.status === "unhealthy"
          ? "warn"
          : undefined;

  return (
    <MobileResourceCard
      title={container.name}
      titleMono
      aria-label={`Container ${container.name}, ${container.status}`}
      attention={dot}
      dimmed={stopped}
      onClick={onOpen ? () => onOpen() : undefined}
      onKeyDown={onKeyDown}
      status={stopped ? null : (
        <>
          {statusChip}
          {healthChip}
        </>
      )}
      context={
        stopped ? (
          <span className="text-text-muted">
            stopped by you · {timeAgo(container.createdAt)}
          </span>
        ) : (
          container.nodeName
        )
      }
      metrics={
        <>
          <span>{container.cpuPercent !== null ? `${container.cpuPercent.toFixed(1)}% cpu` : "— cpu"}</span>
          <span>{container.memoryUsage ?? "— MiB"}</span>
          <span className={cn((container.restartCount ?? 0) >= 3 && "text-warning-foreground")}>
            {container.restartCount ?? 0} restarts
          </span>
          <span>{container.uptime ?? "— up"}</span>
        </>
      }
    />
  );
}

/* ---------------------------- Workloads ----------------------------- */

export function workloadHealthTone(health: WorkloadSummary["health"]): "success" | "warning" | "danger" | "neutral" {
  return health === "healthy" ? "success" : health === "degraded" ? "warning" : health === "down" ? "danger" : "neutral";
}

export function workloadCard(
  workload: WorkloadSummary,
  onOpen?: () => void
): React.JSX.Element {
  const barColor =
    workload.health === "healthy"
      ? "bg-success"
      : workload.health === "degraded"
        ? "bg-warning"
        : workload.health === "down"
          ? "bg-critical"
          : "bg-text-subtle";
  const barWidth = workload.health === "healthy" ? 100 : workload.health === "degraded" ? 75 : workload.health === "down" ? 35 : 0;

  return (
    <MobileResourceCard
      title={workload.name}
      titleMono={false}
      aria-label={`Workload ${workload.name}, ${workload.health}`}
      status={<CardChip tone={workloadHealthTone(workload.health)} dot>{workload.health}</CardChip>}
      context={
        <span className="text-text-muted">
          {workload.nodeName} · {workload.runningContainers}/{workload.totalContainers} running
          {workload.intentionallyStoppedContainers > 0 ? ` · ${workload.intentionallyStoppedContainers} stopped` : ""}
        </span>
      }
      metrics={
        <>
          <span>{workload.cpuPercent !== null ? `${workload.cpuPercent}% CPU` : "— CPU"}</span>
          <span>{workload.memoryUsage ?? "—"}</span>
          <span>{workload.managed ? "managed" : workload.source === "COMPOSE" ? "compose" : "manual"}</span>
        </>
      }
      footer={
        <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-surface-raised">
          <div className={cn("h-full rounded-full", barColor)} style={{ width: `${barWidth}%` }} />
        </div>
      }
      onClick={onOpen ? () => onOpen() : undefined}
    />
  );
}

/* ------------------------------ Nodes ------------------------------- */

export type NodeCardData = {
  id: string;
  name: string;
  hostname?: string | null;
  status?: string;
  isActive?: boolean;
  lastHeartbeatAt: string | null;
  offline: boolean;
  staleHeartbeat: boolean;
  liveContainerCount: number;
  agentVersion?: string | null;
  systemInfo?: Record<string, unknown> | null;
};

export function nodeCard(
  node: NodeCardData,
  thresholds: { cpu: { warning: number; critical: number }; mem: { warning: number; critical: number }; disk: { warning: number; critical: number } },
  onOpen?: () => void
): React.JSX.Element {
  const sys = (node.systemInfo ?? {}) as Record<string, unknown>;
  const cpu = typeof sys.cpuPercent === "number" ? sys.cpuPercent : null;
  const mem = typeof sys.memPercent === "number" ? sys.memPercent : null;
  const totalMem = typeof sys.totalMemBytes === "number" ? (sys.totalMemBytes as number) : null;
  const online = !node.offline && !node.staleHeartbeat;
  const memUsedText = mem !== null && totalMem ? `${mem.toFixed(1)} / ${(totalMem / 1024 ** 3).toFixed(0)} GiB` : "—";
  const memTone = mem !== null && mem >= thresholds.mem.warning ? "warning" : "quiet";

  return (
    <MobileResourceCard
      title={
        <span className="flex items-center gap-3">
          <CardIconTile icon={Server} />
          <span className="min-w-0">
            <span className="block text-[15.5px] font-medium text-text">{node.name}</span>
            {node.hostname && <span className="block font-mono text-[11px] font-normal text-text-muted">{node.hostname}</span>}
          </span>
        </span>
      }
      titleMono={false}
      status={
        <CardChip tone={online ? "success" : node.offline ? "danger" : "warning"} dot>
          {node.offline ? "offline" : node.staleHeartbeat ? "stale" : "online"}
        </CardChip>
      }
      footer={
        <>
          <div className="mt-3.5 flex flex-col gap-2.5">
            <CardMeter label="CPU" value={cpu !== null ? `${cpu.toFixed(0)}%` : "Unknown"} percent={cpu ?? 0} />
            <CardMeter label="Memory" value={mem !== null ? memUsedText : "Unknown"} percent={mem ?? 0} tone={memTone} />
          </div>
          <div className="mt-3.5 flex items-center justify-between border-t border-border/60 pt-3 font-mono text-[11px] text-text-muted">
            <span>{node.liveContainerCount} containers</span>
            <span>{node.agentVersion ?? "agent ?"}{node.hostname?.includes("rootless") ? " · rootless" : ""}</span>
            <span className="inline-flex items-center gap-1 text-success-foreground">
              <Heart size={11} /> {node.lastHeartbeatAt ? timeAgo(node.lastHeartbeatAt).replace(" ago", "") : "—"}
            </span>
          </div>
        </>
      }
      onClick={onOpen ? () => onOpen() : undefined}
    />
  );
}

/* -------------------------- Organizations --------------------------- */

export type MobileClientRow = {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  activeUsers: number;
  workloadCount: number;
  containerCount: number;
  lastActivity: { action: string; createdAt: string; result: string } | null;
};

export function clientCard(client: MobileClientRow, onOpen?: () => void): React.JSX.Element {
  return (
    <MobileResourceCard
      title={client.name}
      titleMono={false}
      aria-label={`Organization ${client.name}`}
      status={<CardChip tone={client.isActive ? "success" : "neutral"} dot>{client.isActive ? "active" : "inactive"}</CardChip>}
      context={<span className="font-mono text-[11px] text-text-subtle">{client.slug}</span>}
      footer={
        <div className="mt-3 flex items-center justify-between border-t border-border/60 pt-3 font-mono text-[11px] text-text-muted">
          <span>{client.activeUsers} users</span>
          <span>{client.workloadCount} workloads</span>
          <span>{client.containerCount} containers</span>
          {client.lastActivity && <span>{timeAgo(client.lastActivity.createdAt)}</span>}
        </div>
      }
      onClick={onOpen ? () => onOpen() : undefined}
    />
  );
}

/* ------------------------------ Users ------------------------------- */

export function userCard(
  user: UserRecord,
  overflow?: React.ReactNode,
  onOpen?: () => void
): React.JSX.Element {
  return (
    <MobileResourceCard
      title={user.displayName || user.email}
      titleMono={false}
      aria-label={`User ${user.displayName || user.email}`}
      status={
        <>
          <CardChip tone="brand">{roleLabel(user.role)}</CardChip>
          {!user.isActive ? (
            <CardChip tone="danger">inactive</CardChip>
          ) : user.pending ? (
            <CardChip tone="warning">pending</CardChip>
          ) : (
            <CardChip tone="success" dot>active</CardChip>
          )}
        </>
      }
      context={<span className="font-mono text-[11px]">{user.email}</span>}
      footer={
        user.clientAccount ? (
          <div className="mt-3 border-t border-border/60 pt-3 font-mono text-[11px] text-text-muted">
            {user.clientAccount.name}
            {overflow && <span className="float-right" data-row-action>{overflow}</span>}
          </div>
        ) : overflow ? (
          <div className="mt-1 flex justify-end" data-row-action>{overflow}</div>
        ) : undefined
      }
      onClick={onOpen ? () => onOpen() : undefined}
    />
  );
}

/* --------------------------- Filter chip row ------------------------ */

/** Compact [Filters N] + active chips row shown on mobile (design §02/§03). */
export function MobileFiltersRow({
  count,
  onOpen,
  chips
}: {
  count: number;
  onOpen: () => void;
  chips?: Array<{ label: string }>;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 overflow-x-auto no-scrollbar py-1" data-mobile-filters-row data-testid="mobile-filters-row">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open filters${count > 0 ? `, ${count} active` : ""}`}
        className="inline-flex h-[34px] flex-none items-center gap-[7px] rounded-[9px] bg-brand/14 px-3 text-[13px] text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        data-filters-button
      >
        <span className="grid h-[14px] w-[14px] place-items-center">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-brand" aria-hidden="true">
            <line x1="21" y1="4" x2="14" y2="4" /><line x1="10" y1="4" x2="3" y2="4" /><line x1="21" y1="12" x2="12" y2="12" /><line x1="8" y1="12" x2="3" y2="12" /><line x1="21" y1="20" x2="16" y2="20" /><line x1="12" y1="20" x2="3" y2="20" /><line x1="14" y1="2" x2="14" y2="6" /><line x1="8" y1="10" x2="8" y2="14" /><line x1="16" y1="18" x2="16" y2="22" />
          </svg>
        </span>
        Filters
        {count > 0 && (
          <span className="grid min-w-[17px] place-items-center rounded-full bg-brand px-1 font-mono text-[10px] leading-[17px] text-text-inverse">
            {count}
          </span>
        )}
      </button>
      {chips?.map((chip) => (
        <span
          key={chip.label}
          className="inline-flex h-[34px] flex-none items-center rounded-[9px] border border-border bg-surface-raised px-3 text-[13px] text-text-muted"
        >
          {chip.label}
        </span>
      ))}
    </div>
  );
}
