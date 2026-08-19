"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Column } from "@/components/ui/data-table";

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
      <div className="rounded-lg border border-danger/30 bg-danger/5 p-6 text-center">
        <p className="text-sm text-red-300">{error}</p>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-panelAlt/50 p-8 text-center">
        <p className="font-medium">{emptyTitle}</p>
        {emptyBody && <p className="mx-auto mt-1 max-w-md text-sm text-muted">{emptyBody}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-panel text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              {columns.map((col) => (
                <th key={col.key} className={cn("px-3 py-2.5 font-medium", col.className)}>
                  {col.sortValue && onSortChange ? (
                    <button
                      type="button"
                      onClick={() => onSortChange(col.key)}
                      className="inline-flex items-center gap-1 rounded hover:text-text focus:outline-none focus:ring-2 focus:ring-accent"
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
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cn(
                  "border-t border-border",
                  onRowClick && "cursor-pointer hover:bg-panelAlt/60"
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

      <div className="flex items-center justify-between text-sm text-muted">
        <span>
          {total > 0 ? `${start}–${end} of ${total}` : "0 results"}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={safePage <= 1}
            onClick={() => onPageChange(safePage - 1)}
            className="rounded border border-border px-2 py-1 disabled:opacity-40 hover:bg-panelAlt focus:outline-none focus:ring-2 focus:ring-accent"
          >
            Prev
          </button>
          <span>
            Page {safePage} of {pageCount}
          </span>
          <button
            type="button"
            disabled={safePage >= pageCount}
            onClick={() => onPageChange(safePage + 1)}
            className="rounded border border-border px-2 py-1 disabled:opacity-40 hover:bg-panelAlt focus:outline-none focus:ring-2 focus:ring-accent"
          >
            Next
          </button>
        </div>
      </div>
      {footer}
    </div>
  );
}
