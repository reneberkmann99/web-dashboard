"use client";

import { Fragment, useEffect, useMemo } from "react";
import { ChevronDown, ChevronUp, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { StatePanel } from "@/components/ui/state-panel";
import { Pagination } from "@/components/ui/pagination";
import { useStoredViewState } from "@/components/navigation/view-state";

export type Column<T> = {
  key: string;
  header: React.ReactNode;
  ariaLabel?: string;
  sortValue?: (row: T) => string | number;
  render: (row: T) => React.ReactNode;
  className?: string;
  hideBelow?: "sm" | "md" | "lg"; // progressive disclosure on small screens
  /** Omit this column when every currently visible row is empty. */
  omitWhenEmpty?: (row: T) => boolean;
  /**
   * Omit this column when every currently visible row shares the same value
   * — a column that reads e.g. "Main VPS" 46 times adds no information, and
   * the active filter chip already says the same thing in one line (design
   * review round 2, §2). Reappears automatically the moment a second value
   * is present (a cleared filter, a different page). Uses `uniformKey` when
   * given, otherwise `sortValue`.
   */
  omitWhenUniform?: boolean;
  uniformKey?: (row: T) => string;
};

export function computeVisibleColumns<T>(columns: Column<T>[], visibleRows: T[]): Column<T>[] {
  return columns.filter((column) => {
    if (column.omitWhenEmpty && !visibleRows.some((row) => !column.omitWhenEmpty?.(row))) return false;
    if (column.omitWhenUniform && visibleRows.length > 1) {
      const keyFn = column.uniformKey ?? (column.sortValue ? (row: T) => String(column.sortValue!(row)) : null);
      if (keyFn) {
        const first = keyFn(visibleRows[0]);
        if (visibleRows.every((row) => keyFn(row) === first)) return false;
      }
    }
    return true;
  });
}

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
  mobileToolbar,
  mobileCard,
  ariaLabel = "Resources",
  onPageRowsChange
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
  /** Replaces the desktop toolbar below md (e.g. a Filters button + sheet). */
  mobileToolbar?: React.ReactNode;
  /** Mobile card presentation (design §02/§19); renders INSTEAD of the table below md. */
  mobileCard?: (row: T) => React.ReactNode;
  ariaLabel?: string;
  /**
   * Reports the exact rows on the currently rendered page whenever they
   * change (sort/search/pagination all included) — for a parent-owned
   * "select all on this page" control, which must scope to what's actually
   * on screen rather than every filtered row across all pages.
   */
  onPageRowsChange?: (rows: T[]) => void;
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
  const visibleColumns = useMemo(() => computeVisibleColumns(columns, pageRows), [columns, pageRows]);

  // Only the row identities (via rowKey, when given) should trigger this —
  // `pageRows` is a fresh array every render regardless of content, and a
  // parent naively storing it in state would loop forever re-rendering.
  const pageRowIdentity = rowKey ? pageRows.map(rowKey).join(",") : pageRows;
  useEffect(() => {
    onPageRowsChange?.(pageRows);
    // pageRowIdentity intentionally stands in for `pageRows` as the effect's
    // real dependency — see the comment above.
  }, [pageRowIdentity]);

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
      {(searchableText || toolbar || mobileToolbar) && (
        <div className="flex flex-wrap items-center gap-2">
          {searchableText && (
            <div className="relative min-w-56 flex-1 sm:max-w-sm max-md:w-full">
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
          {toolbar && <div className="hidden flex-wrap items-center gap-2 md:flex">{toolbar}</div>}
          {mobileToolbar && <div className="w-full md:hidden">{mobileToolbar}</div>}
        </div>
      )}

      <div className={cn("overflow-x-auto rounded-panel border border-border bg-surface-deck md:overflow-x-visible", mobileCard && "max-md:hidden")} data-desktop-table>
        <table className="w-full text-sm" aria-label={ariaLabel}>
          <thead className="sticky top-[52px] z-[5] bg-surface-raised text-left font-mono text-[10px] uppercase tracking-[0.14em] text-text-subtle">
            <tr>
              {visibleColumns.map((col) => (
                <th key={col.key} className={cn(
                  "h-9 px-3 py-2 font-medium",
                  col.className,
                  col.hideBelow === "sm" && "max-md:hidden",
                  col.hideBelow === "md" && "max-lg:hidden",
                  col.hideBelow === "lg" && "max-xl:hidden"
                )}>
                  {col.sortValue ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(col.key)}
                      className="inline-flex items-center gap-1 rounded-control hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                      aria-label={`Sort by ${col.ariaLabel ?? (typeof col.header === "string" ? col.header : col.key)}`}
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
                  "h-11 border-t border-border transition-colors",
                  onRowClick && "cursor-pointer hover:bg-surface-raised focus:bg-selected/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
                )}
              >
                {visibleColumns.map((col) => (
                  <td
                    key={col.key}
                    className={cn(
                      "px-3 py-1.5 align-middle",
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
          </tbody>
        </table>
      </div>

      {mobileCard && (
        <div className="space-y-2.5 md:hidden" aria-label={ariaLabel} data-mobile-cards>
          {pageRows.map((row) => (
            <Fragment key={rowKey ? rowKey(row) : undefined}>{mobileCard(row)}</Fragment>
          ))}
        </div>
      )}

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
