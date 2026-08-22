"use client";

import { Fragment, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatBytesColumn, parseMemoryUsedBytes, compactUptime } from "@/lib/format";
import { StatusBadge } from "@/components/ui/status-badge";
import { AttentionBadge } from "@/components/ui/attention-badge";
import { Pagination } from "@/components/ui/pagination";
import { StatePanel } from "@/components/ui/state-panel";
import type { ContainerView } from "@/types/domain";

export type ContainerGroup = { key: string; name: string; containers: ContainerView[] };

export function groupContainersByWorkload(containers: ContainerView[]): ContainerGroup[] {
  const map = new Map<string, ContainerGroup>();
  for (const c of containers) {
    const key = c.projectId ?? "unassigned";
    const name = c.projectName ?? "Unassigned";
    const group = map.get(key) ?? { key, name, containers: [] };
    group.containers.push(c);
    map.set(key, group);
  }
  return [...map.values()].sort((a, b) => b.containers.length - a.containers.length || a.name.localeCompare(b.name));
}

const GROUP_PAGE_SIZE = 20;

/**
 * Group-by-workload view for Containers (design review round 2, §6). A
 * collapsible parent row per workload ("Mailcow · 18 containers · 2.5G")
 * turns a wall of same-prefix containers into a handful of lines; expanding
 * reveals the individual containers with the same status/CPU/memory/actions
 * as the flat list. Search, filters, and selection are unaffected — this
 * component only changes how the already-filtered row set is *displayed*.
 */
export function GroupedContainers({
  containers,
  selected,
  onToggleOne,
  onToggleMany,
  onRowClick,
  renderActions
}: {
  containers: ContainerView[];
  selected: Set<string>;
  onToggleOne: (key: string, checked: boolean) => void;
  onToggleMany: (keys: string[], checked: boolean) => void;
  onRowClick: (container: ContainerView) => void;
  renderActions: (container: ContainerView) => React.ReactNode;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);

  const groups = useMemo(() => groupContainersByWorkload(containers), [containers]);
  const formatGroupMemory = useMemo(
    () => formatBytesColumn(groups.map((g) => g.containers.reduce((sum, c) => sum + (parseMemoryUsedBytes(c.memoryUsage) ?? 0), 0))),
    [groups]
  );
  const formatRowMemory = useMemo(() => formatBytesColumn(containers.map((c) => parseMemoryUsedBytes(c.memoryUsage))), [containers]);

  if (groups.length === 0) {
    return <StatePanel title="No containers" description="Containers appear here once an agent reports them." />;
  }

  const pageCount = Math.max(1, Math.ceil(groups.length / GROUP_PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageGroups = groups.slice(safePage * GROUP_PAGE_SIZE, (safePage + 1) * GROUP_PAGE_SIZE);

  const rowKey = (c: ContainerView): string => `${c.nodeId}:${c.containerId}`;

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-panel border border-border bg-surface-deck md:overflow-x-visible" data-desktop-table data-grouped-containers>
        <table className="w-full text-sm" aria-label="Containers grouped by workload">
          <thead className="sticky top-[52px] z-[5] bg-surface-raised text-left font-mono text-[10px] uppercase tracking-[0.14em] text-text-subtle">
            <tr>
              <th className="h-9 w-10 px-3 py-2" />
              <th className="h-9 px-3 py-2 font-medium">Workload</th>
              <th className="h-9 px-3 py-2 font-medium text-right">Containers</th>
              <th className="h-9 px-3 py-2 font-medium text-right">Running</th>
              <th className="h-9 px-3 py-2 font-medium text-right">Memory</th>
            </tr>
          </thead>
          <tbody>
            {pageGroups.map((group) => {
              const isExpanded = expanded.has(group.key);
              const groupKeys = group.containers.map(rowKey);
              const allSelected = groupKeys.every((k) => selected.has(k));
              const someSelected = !allSelected && groupKeys.some((k) => selected.has(k));
              const running = group.containers.filter((c) => c.status === "running").length;
              const totalBytes = group.containers.reduce((sum, c) => sum + (parseMemoryUsedBytes(c.memoryUsage) ?? 0), 0);
              return (
                <Fragment key={group.key}>
                  <tr className="h-11 border-t border-border bg-surface-raised/40">
                    <td className="px-3 py-1.5 text-center">
                      <input
                        type="checkbox"
                        aria-label={`Select all containers in ${group.name}`}
                        checked={allSelected}
                        ref={(el) => { if (el) el.indeterminate = someSelected; }}
                        onChange={(event) => onToggleMany(groupKeys, event.target.checked)}
                        className="h-4 w-4 accent-brand"
                      />
                    </td>
                    <td className="px-3 py-1.5">
                      <button
                        type="button"
                        onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(group.key)) next.delete(group.key); else next.add(group.key); return next; })}
                        className="flex items-center gap-1.5 font-medium text-text hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                        aria-expanded={isExpanded}
                      >
                        {isExpanded ? <ChevronDown size={14} className="shrink-0 text-text-subtle" /> : <ChevronRight size={14} className="shrink-0 text-text-subtle" />}
                        {group.name}
                      </button>
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-xs tabular-nums text-text-muted">{group.containers.length}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-xs tabular-nums text-text-muted">{running}/{group.containers.length}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-xs tabular-nums text-text-muted">{formatGroupMemory(totalBytes)}</td>
                  </tr>
                  {isExpanded &&
                    group.containers.map((c) => (
                      <tr
                        key={rowKey(c)}
                        onClick={(event) => { if (!(event.target as Element).closest("a, button, input, [role='menuitem'], [data-row-action]")) onRowClick(c); }}
                        className="h-11 cursor-pointer border-t border-border/60 transition-colors hover:bg-surface-raised"
                      >
                        <td className="px-3 py-1.5 text-center">
                          <input
                            type="checkbox"
                            aria-label={`Select ${c.name}`}
                            checked={selected.has(rowKey(c))}
                            onChange={(event) => onToggleOne(rowKey(c), event.target.checked)}
                            className="h-4 w-4 accent-brand"
                          />
                        </td>
                        <td className="px-3 py-1.5 pl-8">
                          <p className="max-w-[280px] truncate font-mono text-[13px] text-text" title={c.name}>{c.name}</p>
                        </td>
                        <td className="px-3 py-1.5 text-right"><StatusBadge status={c.status} expectedStopped={c.expectedStopped} health={c.health} /></td>
                        <td className={cn("px-3 py-1.5 text-right font-mono text-xs tabular-nums text-text-muted")}>{formatRowMemory(parseMemoryUsedBytes(c.memoryUsage))}</td>
                        <td className="px-3 py-1.5 text-right">
                          <div className="flex items-center justify-end gap-2">
                            {c.attention && c.attention !== "healthy" && <AttentionBadge severity={c.attention} />}
                            <span className="font-mono text-[11px] text-text-subtle">{compactUptime(c.uptime)}</span>
                            {renderActions(c)}
                          </div>
                        </td>
                      </tr>
                    ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {pageCount > 1 && (
        <Pagination
          start={safePage * GROUP_PAGE_SIZE + 1}
          end={Math.min((safePage + 1) * GROUP_PAGE_SIZE, groups.length)}
          total={groups.length}
          page={safePage + 1}
          pageCount={pageCount}
          onPageChange={(p) => setPage(Math.max(0, p - 1))}
        />
      )}
    </div>
  );
}
