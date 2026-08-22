"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronLeft, Plus, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type DesktopFilterDimension = {
  id: string;
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
};

/**
 * Canonical desktop filter bar. Unset dimensions stay behind Add filter;
 * active values are individually removable chips. Pages own URL state so
 * the component remains reusable for both client- and server-filtered lists.
 */
export function DesktopFilterBar({
  search,
  onSearchChange,
  searchPlaceholder = "Search…",
  dimensions = [],
  toggles = [],
  resultCount,
  totalCount,
  onClearAll,
  className
}: {
  search?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  dimensions?: DesktopFilterDimension[];
  toggles?: Array<{ id: string; label: string; active: boolean; onChange: (active: boolean) => void }>;
  resultCount: number;
  totalCount?: number;
  onClearAll?: () => void;
  className?: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [dimensionId, setDimensionId] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const activeDimensions = dimensions.filter((dimension) => dimension.value);
  const activeToggles = toggles.filter((toggle) => toggle.active);
  const hasActive = Boolean(search || activeDimensions.length || activeToggles.length);
  const available = dimensions.filter((dimension) => !dimension.value);
  const selectedDimension = dimensions.find((dimension) => dimension.id === dimensionId) ?? null;

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent): void => {
      if (!ref.current?.contains(event.target as Node)) {
        setOpen(false);
        setDimensionId(null);
      }
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setOpen(false);
        setDimensionId(null);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const countLabel = totalCount !== undefined && resultCount !== totalCount
    ? `${resultCount} of ${totalCount}`
    : `${resultCount} result${resultCount === 1 ? "" : "s"}`;

  return (
    <div
      className={cn("hidden min-h-10 items-center gap-2 rounded-panel border border-border bg-surface-deck px-2 py-1.5 md:flex", className)}
      data-desktop-filter-bar
    >
      {onSearchChange && (
        <label className="relative min-w-48 max-w-72 flex-1">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-subtle" />
          <input
            type="search"
            value={search ?? ""}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            className="h-8 w-full rounded-control border border-border bg-surface-raised pl-8 pr-2 text-[13px] text-text placeholder:text-text-subtle focus:border-selected-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30"
          />
        </label>
      )}

      {activeDimensions.map((dimension) => {
        const label = dimension.options.find((option) => option.value === dimension.value)?.label ?? dimension.value;
        return (
          <button
            key={dimension.id}
            type="button"
            onClick={() => dimension.onChange("")}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-control bg-selected/70 px-2.5 text-[13px] text-text hover:bg-selected focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            aria-label={`Remove ${dimension.label} filter ${label}`}
          >
            {label}<X size={12} className="text-brand-hover" />
          </button>
        );
      })}

      {activeToggles.map((toggle) => (
        <button
          key={toggle.id}
          type="button"
          onClick={() => toggle.onChange(false)}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-control bg-selected/70 px-2.5 text-[13px] text-text hover:bg-selected focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          aria-label={`Remove ${toggle.label} filter`}
        >
          {toggle.label}<X size={12} className="text-brand-hover" />
        </button>
      ))}

      {(available.length > 0 || toggles.some((toggle) => !toggle.active)) && (
        <div ref={ref} className="relative shrink-0">
          <button
            type="button"
            onClick={() => {
              setOpen((value) => !value);
              setDimensionId(null);
            }}
            aria-expanded={open}
            className="inline-flex h-8 items-center gap-1.5 rounded-control border border-dashed border-border-strong px-2.5 text-[13px] text-text-muted hover:border-selected-border/50 hover:bg-surface-raised hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <Plus size={13} /> Add filter
          </button>
          {open && (
            <div className="absolute left-0 top-full z-40 mt-1 w-56 rounded-panel border border-border bg-surface-overlay p-1.5 shadow-overlay">
              {selectedDimension ? (
                <>
                  <button
                    type="button"
                    onClick={() => setDimensionId(null)}
                    className="mb-1 flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-xs text-text-muted hover:bg-surface-raised hover:text-text"
                  >
                    <ChevronLeft size={13} /> {selectedDimension.label}
                  </button>
                  {selectedDimension.options.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => {
                        selectedDimension.onChange(option.value);
                        setOpen(false);
                        setDimensionId(null);
                      }}
                      className="flex w-full items-center justify-between rounded-control px-2.5 py-2 text-left text-[13px] text-text hover:bg-surface-raised"
                    >
                      {option.label}
                      {selectedDimension.value === option.value && <Check size={13} className="text-brand" />}
                    </button>
                  ))}
                </>
              ) : (
                <>
                  {available.map((dimension) => (
                    <button
                      key={dimension.id}
                      type="button"
                      onClick={() => setDimensionId(dimension.id)}
                      className="flex w-full items-center justify-between rounded-control px-2.5 py-2 text-left text-[13px] text-text hover:bg-surface-raised"
                    >
                      {dimension.label}<Plus size={13} className="text-text-subtle" />
                    </button>
                  ))}
                  {toggles.filter((toggle) => !toggle.active).map((toggle) => (
                    <button
                      key={toggle.id}
                      type="button"
                      onClick={() => {
                        toggle.onChange(true);
                        setOpen(false);
                      }}
                      className="flex w-full items-center justify-between rounded-control px-2.5 py-2 text-left text-[13px] text-text hover:bg-surface-raised"
                    >
                      {toggle.label}<Plus size={13} className="text-text-subtle" />
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {hasActive && onClearAll && (
        <button type="button" onClick={onClearAll} className="shrink-0 rounded-control px-2 py-1 text-xs text-text-muted hover:bg-surface-raised hover:text-text">
          Clear all
        </button>
      )}
      <span className="ml-auto shrink-0 rounded-control border border-border bg-surface-raised px-2.5 py-1.5 font-mono text-[11px] tabular-nums text-text-muted" data-result-count>
        {countLabel}
      </span>
    </div>
  );
}
