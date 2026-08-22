import * as React from "react";
import { cn } from "@/lib/utils";

export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>): React.JSX.Element {
  return (
    <textarea
      className={cn(
        "w-full rounded-control border border-border bg-surface-raised px-3 py-2 text-sm text-text shadow-inner shadow-black/10 transition-colors placeholder:text-text-subtle hover:border-border-strong focus:border-selected-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-critical",
        className
      )}
      {...props}
    />
  );
}
