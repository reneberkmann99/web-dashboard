import * as React from "react";
import { cn } from "@/lib/utils";

export function CodePanel({
  children,
  label,
  actions,
  className,
  scroll = true
}: {
  children: React.ReactNode;
  label?: string;
  actions?: React.ReactNode;
  className?: string;
  scroll?: boolean;
}): React.JSX.Element {
  return (
    <section className={cn("overflow-hidden rounded-panel border border-border bg-surface-hull/75", className)}>
      {(label || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-border bg-surface-deck px-3 py-2">
          {label && <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">{label}</p>}
          {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn("font-mono text-xs leading-relaxed text-text", scroll && "overflow-auto", "p-3")}>{children}</div>
    </section>
  );
}
