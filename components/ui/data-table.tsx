"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { StatePanel } from "@/components/ui/state-panel";

export type Column<T> = {
  key: string;
  header: string;
  sortValue?: (row: T) => string | number;
  render: (row: T) => React.ReactNode;
  className?: string;
  hideBelow?: "sm" | "md" | "lg"; // progressive disclosure on small screens
};

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
  rowKey
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
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<string | undefined>(initialSort);
  const [sortDir, setSortDir] = useState<"asc" | "desc">(initialSortDir);
  const [page, setPage] = useState(0);

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
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

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
      {searchableText && (
        <div className="relative max-w-sm">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <Input
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
            }}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            className="pl-9"
          />
        </div>
      )}

      <div className="overflow-x-auto rounded-panel border border-border bg-surface-deck">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-surface-raised/85 text-left font-mono text-[11px] uppercase tracking-[0.12em] text-text-muted backdrop-blur">
            <tr>
              {columns.map((col) => (
                <th key={col.key} className={cn("px-3 py-2.5 font-medium", col.className)}>
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
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cn(
                  "border-t border-border transition-colors",
                  onRowClick && "cursor-pointer hover:bg-surface-raised/60",
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
              <tr key={`${rowKey ? rowKey(row) : rowIndex}-card`} className="border-t border-border md:hidden">
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
        <div className="flex items-center justify-between text-sm text-muted">
          <span>
            {safePage * pageSize + 1}–{Math.min((safePage + 1) * pageSize, filtered.length)} of {filtered.length}
          </span>
          <div className="flex gap-2">
            <Button
              disabled={safePage === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              variant="outline"
              size="sm"
            >
              Prev
            </Button>
            <Button
              disabled={safePage >= pageCount - 1}
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              variant="outline"
              size="sm"
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
