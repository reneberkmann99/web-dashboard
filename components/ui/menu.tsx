"use client";

import { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type MenuItem = { label: string; onSelect: () => void; disabled?: boolean; tone?: "default" | "danger" };

export function Menu({ items, label = "Open menu", align = "right", side = "bottom", trigger, triggerClassName }: { items: MenuItem[]; label?: string; align?: "left" | "right"; side?: "top" | "bottom"; trigger?: React.ReactNode; triggerClassName?: string }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent): void => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    const closeOnEscape = (event: KeyboardEvent): void => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative inline-flex" data-row-action onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      <Button variant="ghost" size="sm" className={triggerClassName} aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{trigger ?? <MoreHorizontal className="h-4 w-4" />}</Button>
      {open && <div role="menu" className={cn("absolute z-30 min-w-44 rounded-control border border-border bg-surface-overlay p-1 shadow-overlay", side === "top" ? "bottom-full mb-1" : "top-full mt-1", align === "right" ? "right-0" : "left-0")}>
        {items.map((item) => <button key={item.label} type="button" role="menuitem" disabled={item.disabled} onClick={() => { item.onSelect(); setOpen(false); }} className={cn("block w-full rounded-sm px-3 py-2 text-left text-sm transition-colors hover:bg-surface-raised disabled:opacity-45", item.tone === "danger" ? "text-critical-foreground" : "text-text")}>{item.label}</button>)}
      </div>}
    </div>
  );
}
