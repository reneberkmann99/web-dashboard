import * as React from "react";
import { cn } from "@/lib/utils";

export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>): React.JSX.Element {
  return (
    <select
      className={cn(
        "h-control w-full rounded-control border border-border bg-surface-raised px-3 py-2 text-sm text-text shadow-inner shadow-black/10 transition-colors hover:border-border-strong focus:border-selected-border focus:outline-none focus:ring-2 focus:ring-focus/30 disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-critical",
        className
      )}
      {...props}
    />
  );
}
