"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export type TimeRangeKey = "1h" | "24h" | "7d" | "custom";

const RANGE_MS: Record<Exclude<TimeRangeKey, "custom">, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000
};

const RANGE_LABEL: Record<TimeRangeKey, string> = {
  "1h": "Last hour",
  "24h": "Last 24h",
  "7d": "Last 7d",
  custom: "Custom"
};

/** Effective `from` ISO timestamp for a relative range, evaluated at call time so it keeps sliding forward on refetch. */
export function rangeToFrom(range: Exclude<TimeRangeKey, "custom">): string {
  return new Date(Date.now() - RANGE_MS[range]).toISOString();
}

/**
 * The first filter chip on Activity (design review round 2, §10): 845
 * events need a time bound before search does any good. Defaults to 24h;
 * Custom exposes a real start/end range. State lives in the URL via the
 * parent's syncUrl so filtered views stay shareable and Back/Forward works.
 */
export function TimeRangeFilter({
  range,
  from,
  to,
  onChange
}: {
  range: TimeRangeKey;
  from: string;
  to: string;
  onChange: (next: { range: TimeRangeKey; from: string; to: string }) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent): void => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  // datetime-local inputs want "YYYY-MM-DDTHH:mm" in local time, not a full ISO string.
  const toLocalInput = (iso: string): string => {
    if (!iso) return "";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    const offset = date.getTimezoneOffset();
    return new Date(date.getTime() - offset * 60000).toISOString().slice(0, 16);
  };
  const fromLocalInput = (local: string): string => (local ? new Date(local).toISOString() : "");

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-control bg-selected/70 px-2.5 text-[13px] text-text hover:bg-selected focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {RANGE_LABEL[range]}
        <ChevronDown size={13} className="text-text-subtle" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-40 mt-1 w-64 rounded-panel border border-border bg-surface-overlay p-1.5 shadow-overlay">
          {(["1h", "24h", "7d"] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => {
                onChange({ range: key, from: "", to: "" });
                setOpen(false);
              }}
              className="flex w-full items-center justify-between rounded-control px-2.5 py-2 text-left text-[13px] text-text hover:bg-surface-raised"
            >
              {RANGE_LABEL[key]}
              {range === key && <Check size={13} className="text-brand" />}
            </button>
          ))}
          <div className="mt-1 border-t border-border pt-1.5">
            <p className="px-2.5 pb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-text-subtle">Custom</p>
            <div className="space-y-1.5 px-2.5 pb-1.5">
              <label className="block text-[11px] text-text-muted">
                Start
                <input
                  type="datetime-local"
                  value={toLocalInput(from)}
                  onChange={(event) => onChange({ range: "custom", from: fromLocalInput(event.target.value), to })}
                  className={cn("mt-0.5 h-8 w-full rounded-control border border-border bg-surface-raised px-2 text-[13px] text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30")}
                />
              </label>
              <label className="block text-[11px] text-text-muted">
                End
                <input
                  type="datetime-local"
                  value={toLocalInput(to)}
                  onChange={(event) => onChange({ range: "custom", from, to: fromLocalInput(event.target.value) })}
                  className={cn("mt-0.5 h-8 w-full rounded-control border border-border bg-surface-raised px-2 text-[13px] text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30")}
                />
              </label>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
