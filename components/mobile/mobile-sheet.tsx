"use client";

import { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";
import { useFocusTrap } from "@/components/ui/use-focus-trap";
import { cn } from "@/lib/utils";

/**
 * Mobile bottom sheet (design §03/§07 treatment).
 *
 * Safe-area aware, drag-handle affordance, focus trapped, Escape/backdrop
 * dismiss, labelled by its title. Renders a bottom sheet anchored to the
 * viewport bottom above `env(safe-area-inset-bottom)`. Never a desktop modal —
 * on ≥768px callers keep their desktop equivalents (FilterSheet renders
 * nothing above the mobile breakpoint).
 */
export function MobileSheet({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}): React.JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusTrap(ref, open, false);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overscrollBehaviorY = "none";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overscrollBehaviorY = "";
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col justify-end bg-[#05070d]/72"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cn(
          "flex max-h-[88dvh] flex-col rounded-t-[22px] border-t border-border bg-surface-deck shadow-overlay outline-none safe-bottom",
          className
        )}
      >
        <div className="flex-none px-5 pt-2.5">
          <div className="mx-auto h-1 w-10 rounded-full bg-border-strong/70" aria-hidden="true" />
        </div>
        <header className="flex flex-none items-center justify-between px-5 pb-1 pt-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-[17px] font-semibold leading-tight">
              {title}
            </h2>
            {description && <p className="mt-0.5 text-sm text-text-muted">{description}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-11 w-11 flex-none place-items-center rounded-control text-text-muted transition-colors hover:bg-surface-raised hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <X size={20} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-2">{children}</div>
        {footer && (
          <div className="flex-none border-t border-border px-5 pt-4 pb-1">{footer}</div>
        )}
      </div>
    </div>
  );
}
