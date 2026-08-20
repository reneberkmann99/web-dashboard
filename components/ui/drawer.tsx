"use client";

import { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useFocusTrap } from "@/components/ui/use-focus-trap";
import { cn } from "@/lib/utils";

export function Drawer({ open, onClose, title, description, children, footer, side = "right" }: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  side?: "left" | "right";
}): React.JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusTrap(ref, open, true);

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent): void => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-black/65" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className={cn("absolute inset-y-0 flex w-full max-w-lg flex-col border-border bg-surface-overlay shadow-overlay outline-none", side === "right" ? "right-0 border-l" : "left-0 border-r")}>
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div><h2 id={titleId} className="text-lg font-semibold">{title}</h2>{description && <p className="mt-1 text-sm text-text-muted">{description}</p>}</div>
          <Button variant="ghost" size="sm" aria-label="Close drawer" onClick={onClose}><X className="h-4 w-4" /></Button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}
