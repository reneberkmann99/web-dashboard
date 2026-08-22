"use client";

import { cn } from "@/lib/utils";

/**
 * Accessible tab bar: ARIA tablist/tab roles, arrow-key navigation,
 * aria-selected state. Intended for the read-only tab panels used across the
 * dashboard (workload/node/client detail) — panels themselves render in the
 * page flow and are labelled via aria-labelledby.
 */
export function TabBar<T extends string>({
  tabs,
  active,
  onChange,
  idPrefix
}: {
  tabs: readonly T[];
  active: T;
  onChange: (tab: T) => void;
  idPrefix: string;
}): React.JSX.Element {
  const index = tabs.indexOf(active);

  const onKeyDown = (event: React.KeyboardEvent, i: number): void => {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      onChange(tabs[(i + 1) % tabs.length]);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      onChange(tabs[(i - 1 + tabs.length) % tabs.length]);
    } else if (event.key === "Home") {
      event.preventDefault();
      onChange(tabs[0]);
    } else if (event.key === "End") {
      event.preventDefault();
      onChange(tabs[tabs.length - 1]);
    }
  };

  return (
    <div role="tablist" aria-label="Sections" className="flex gap-6 overflow-x-auto border-b border-border">
      {tabs.map((t, i) => {
        const selected = t === active;
        return (
          <button
            key={t}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${t}`}
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel-${t}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(t)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              "relative shrink-0 px-0.5 pb-2.5 pt-1 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus",
              selected
                ? "font-medium text-text after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-selected-border"
                : "text-text-muted hover:text-text"
            )}
          >
            {t}
          </button>
        );
      })}
      {/* aria-orientation helper for screen readers; index kept for debugging */}
      <span className="sr-only">Active tab index {index + 1} of {tabs.length}</span>
    </div>
  );
}
