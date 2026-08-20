"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { isInteractiveTableTarget, type Column } from "@/components/ui/data-table";
import { StatePanel } from "@/components/ui/state-panel";
import { Pagination } from "@/components/ui/pagination";

/**
 * Server-side data table: the API returns one page; this component renders it
 * and drives sort/page changes back to the parent (which refetches). It does
 * NOT filter/sort/paginate in the browser.
 */
export function ServerDataTable<T>({
  columns,
  rows,
  total,
  page,
  pageSize,
  onPageChange,
  sortKey,
  sortDir,
  onSortChange,
  loading = false,
  error,
  emptyTitle = "Nothing here yet",
  emptyBody,
  onRowClick,
  rowKey,
  footer
}: {
  columns: Column<T>[];
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  sortKey?: string;
  sortDir?: "asc" | "desc";
  onSortChange?: (key: string) => void;
  loading?: boolean;
  error?: string | null;
  emptyTitle?: string;
  emptyBody?: string;
  onRowClick?: (row: T) => void;
  rowKey?: (row: T) => string;
  footer?: React.ReactNode;
}): React.JSX.Element {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(page, 1), pageCount);
  const start = total === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const end = Math.min(safePage * pageSize, total);
  const openRow = (row: T, event: React.MouseEvent | React.KeyboardEvent): void => {
    if (!onRowClick || isInteractiveTableTarget(event.target)) return;
    if ("key" in event && event.key !== "Enter" && event.key !== " ") return;
    if ("key" in event) event.preventDefault();
    onRowClick(row);
  };

  if (loading) {
    return (
      <div className="space-y-3" aria-busy="true">
        <div className="h-10 animate-pulse rounded bg-panelAlt" />
        <div className="h-10 animate-pulse rounded bg-panelAlt" />
        <div className="h-10 animate-pulse rounded bg-panelAlt" />
      </div>
    );
  }

  if (error) {
    return (
      <StatePanel tone="error" title="Unable to load data" description={error} />
    );
  }

  if (rows.length === 0) {
    return (
      <StatePanel title={emptyTitle} description={emptyBody} />
    );
  }

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-panel border border-border bg-surface-deck">
        <table className="w-full text-sm" aria-label="Resources">
          <thead className="sticky top-0 bg-surface-raised/85 text-left font-mono text-[11px] uppercase tracking-[0.12em] text-text-muted backdrop-blur">
            <tr>
              {columns.map((col) => (
                <th key={col.key} className={cn("px-3 py-2.5 font-medium", col.className)}>
                  {col.sortValue && onSortChange ? (
                    <button
                      type="button"
                      onClick={() => onSortChange(col.key)}
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
            {rows.map((row, rowIndex) => (
              <tr
                key={rowKey ? rowKey(row) : `row-${rowIndex}`}
                onClick={onRowClick ? (event) => openRow(row, event) : undefined}
                onKeyDown={onRowClick ? (event) => openRow(row, event) : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                role={onRowClick ? "link" : undefined}
                data-row-key={rowKey ? rowKey(row) : undefined}
                className={cn(
                  "h-12 border-t border-border transition-colors",
                  onRowClick && "cursor-pointer hover:bg-surface-raised/60 focus:bg-selected/35 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-focus"
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
          </tbody>
        </table>
      </div>

      <Pagination
        start={start}
        end={end}
        total={total}
        page={safePage}
        pageCount={pageCount}
        onPageChange={onPageChange}
      />
      {footer}
    </div>
  );
}
