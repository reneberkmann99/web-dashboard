"use client";

import { useMemo } from "react";
import { ChevronDown, ChevronUp, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { StatePanel } from "@/components/ui/state-panel";
import { Pagination } from "@/components/ui/pagination";
import { useStoredViewState } from "@/components/navigation/view-state";

export type Column<T> = {
  key: string;
  header: string;
  sortValue?: (row: T) => string | number;
  render: (row: T) => React.ReactNode;
  className?: string;
  hideBelow?: "sm" | "md" | "lg"; // progressive disclosure on small screens
};

export function isInteractiveTableTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("a, button, input, select, textarea, [role='menuitem'], [data-row-action]"));
}

export function DataTable<T>({
  columns,
  rows,
  searchPlaceholder = "Search…",
  searchableText,
  initialSort,
  initialSortDir = "asc",
  emptyTitle = "Nothing here yet",
  emptyBody,
  emptyAction,
  loading = false,
  error,
  pageSize = 25,
  onRowClick,
  rowKey,
  stateKey,
  toolbar,
  ariaLabel = "Resources"
}: {
  columns: Column<T>[];
  rows: T[];
  searchPlaceholder?: string;
  searchableText?: (row: T) => string;
  initialSort?: string;
  initialSortDir?: "asc" | "desc";
  emptyTitle?: string;
  emptyBody?: string;
  emptyAction?: React.ReactNode;
  loading?: boolean;
  error?: string | null;
  pageSize?: number;
  onRowClick?: (row: T) => void;
  rowKey?: (row: T) => string;
  stateKey?: string;
  toolbar?: React.ReactNode;
  ariaLabel?: string;
}): React.JSX.Element {
  const [view, setView] = useStoredViewState(stateKey ? `table:${stateKey}` : null, {
    query: "",
    sortKey: initialSort,
    sortDir: initialSortDir,
    page: 0
  });
  const { query, sortKey, sortDir, page } = view;

  const filtered = useMemo(() => {
    let out = rows;
    if (query && searchableText) {
      const q = query.toLowerCase();
      out = out.filter((row) => searchableText(row).toLowerCase().includes(q));
    }
    if (sortKey) {
      const col = columns.find((c) => c.key === sortKey);
      if (col?.sortValue) {
        out = [...out].sort((a, b) => {
          const av = col.sortValue!(a);
          const bv = col.sortValue!(b);
          const cmp = av < bv ? -1 : av > bv ? 1 : 0;
          return sortDir === "asc" ? cmp : -cmp;
        });
      }
    }
    return out;
  }, [rows, query, sortKey, sortDir, columns, searchableText]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(safePage * pageSize, (safePage + 1) * pageSize);

  function toggleSort(key: string): void {
    if (sortKey === key) {
      setView((current) => ({ ...current, sortDir: current.sortDir === "asc" ? "desc" : "asc", page: 0 }));
    } else {
      setView((current) => ({ ...current, sortKey: key, sortDir: "asc", page: 0 }));
    }
  }

  const openRow = (row: T, event: React.MouseEvent | React.KeyboardEvent): void => {
    if (!onRowClick || isInteractiveTableTarget(event.target)) return;
    if ("key" in event && event.key !== "Enter" && event.key !== " ") return;
    if ("key" in event) event.preventDefault();
    onRowClick(row);
  };

  if (loading) {
    return (
      <div className="space-y-3" aria-busy="true">
        <div className="h-control animate-pulse rounded-control bg-surface-raised" />
        <div className="h-control animate-pulse rounded-control bg-surface-raised" />
        <div className="h-control animate-pulse rounded-control bg-surface-raised" />
      </div>
    );
  }

  if (error) {
    return (
      <StatePanel tone="error" title="Unable to load data" description={error} />
    );
  }

  if (filtered.length === 0) {
    return (
      <StatePanel title={emptyTitle} description={emptyBody} action={emptyAction} />
    );
  }

  return (
    <div className="space-y-3">
      {(searchableText || toolbar) && (
        <div className="flex flex-wrap items-center gap-2">
          {searchableText && (
            <div className="relative min-w-56 flex-1 sm:max-w-sm">
              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <Input
                type="search"
                value={query}
                onChange={(event) => setView((current) => ({ ...current, query: event.target.value, page: 0 }))}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                className="pl-9"
              />
            </div>
          )}
          {toolbar}
        </div>
      )}

      <div className="overflow-x-auto rounded-panel border border-border bg-surface-deck">
        <table className="w-full text-sm" aria-label={ariaLabel}>
          <thead className="sticky top-0 bg-surface-raised/85 text-left font-mono text-[11px] uppercase tracking-[0.12em] text-text-muted backdrop-blur">
            <tr>
              {columns.map((col) => (
                <th key={col.key} className={cn(
                  "px-3 py-2.5 font-medium",
                  col.className,
                  col.hideBelow === "sm" && "max-md:hidden",
                  col.hideBelow === "md" && "max-lg:hidden",
                  col.hideBelow === "lg" && "max-xl:hidden"
                )}>
                  {col.sortValue ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(col.key)}
                      className="inline-flex items-center gap-1 rounded-control hover:text-text focus:outline-none focus:ring-2 focus:ring-focus"
                      aria-label={`Sort by ${col.header}`}
                    >
                      {col.header}
                      {sortKey === col.key &&
                        (sortDir === "asc" ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row, rowIndex) => (
              <tr
                key={rowKey ? rowKey(row) : `row-${rowIndex}`}
                onClick={onRowClick ? (event) => openRow(row, event) : undefined}
                onKeyDown={onRowClick ? (event) => openRow(row, event) : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                role={onRowClick ? "link" : undefined}
                data-row-key={rowKey ? rowKey(row) : undefined}
                className={cn(
                  "h-12 border-t border-border transition-colors",
                  onRowClick && "cursor-pointer hover:bg-surface-raised/60 focus:bg-selected/35 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-focus",
                  "max-md:hidden" // fallback handled below
                )}
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={cn(
                      "px-3 py-2.5 align-middle",
                      col.className,
                      col.hideBelow === "sm" && "max-md:hidden",
                      col.hideBelow === "md" && "max-lg:hidden",
                      col.hideBelow === "lg" && "max-xl:hidden"
                    )}
                  >
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))}
            {/* Mobile fallback: card rows for small screens */}
            {pageRows.map((row, rowIndex) => (
              <tr
                key={`${rowKey ? rowKey(row) : rowIndex}-card`}
                className={cn("border-t border-border md:hidden", onRowClick && "cursor-pointer hover:bg-surface-raised/60")}
                onClick={onRowClick ? (event) => openRow(row, event) : undefined}
                onKeyDown={onRowClick ? (event) => openRow(row, event) : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                role={onRowClick ? "link" : undefined}
                data-row-key={rowKey ? rowKey(row) : undefined}
              >
                <td className="px-3 py-3">
                  {columns
                    .filter((c) => c.hideBelow === undefined)
                    .slice(0, 3)
                    .map((col) => (
                      <div key={col.key} className="py-0.5">
                        <span className="text-xs uppercase tracking-wide text-muted">{col.header}: </span>
                        {col.render(row)}
                      </div>
                    ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pageCount > 1 && (
        <Pagination
          start={safePage * pageSize + 1}
          end={Math.min((safePage + 1) * pageSize, filtered.length)}
          total={filtered.length}
          page={safePage + 1}
          pageCount={pageCount}
          onPageChange={(p) => setView((current) => ({ ...current, page: Math.max(0, p - 1) }))}
        />
      )}
    </div>
  );
}
