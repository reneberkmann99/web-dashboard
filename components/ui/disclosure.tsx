"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Collapsed-by-default disclosure for dense/long content that would
 * otherwise dominate a page (design P0.3 — Labels chip pile, Networks when
 * there are more than a handful of entries). Closed by default; the trigger
 * states the count so nobody has to open it to know how much is there.
 */
export function Disclosure({
  label,
  count,
  defaultOpen = false,
  children,
  action
}: {
  label: string;
  count?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
  /** Optional trailing action shown only while open (e.g. "Copy all as JSON"). */
  action?: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex flex-1 items-center gap-1.5 rounded-control py-0.5 text-left text-sm font-semibold uppercase tracking-wide text-text-muted transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <ChevronRight size={14} className={cn("shrink-0 transition-transform", open && "rotate-90")} />
          <span>
            {label}
            {count !== undefined && <span className="ml-1 font-mono text-xs text-text-subtle normal-case tracking-normal">({count})</span>}
          </span>
        </button>
        {open && action}
      </div>
      {open && <div className="mt-3">{children}</div>}
    </div>
  );
}
