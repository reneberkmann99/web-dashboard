import * as React from "react";
import { cn } from "@/lib/utils";

export function Badge({
  className,
  variant = "default",
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & {
  variant?: "default" | "success" | "warning" | "danger" | "info" | "selected" | "outline" | "neutral";
}): React.JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border border-transparent px-2 py-0.5 text-xs font-medium leading-5",
        variant === "default" && "bg-surface-raised text-text-muted",
        // Every STATE chip carries a dot (active/inactive, running/stopped, …)
        // so "inactive" doesn't read as a different, dot-less kind of label
        // than "active" (design review round 2, consistency debts §06).
        variant === "neutral" && "border-border bg-surface-raised/70 text-text-muted before:mr-1.5 before:h-1.5 before:w-1.5 before:rounded-full before:bg-text-subtle",
        variant === "success" && "border-border bg-surface-raised/70 text-text-muted before:mr-1.5 before:h-1.5 before:w-1.5 before:rounded-full before:bg-success",
        variant === "warning" && "border-warning/20 bg-warning/15 text-warning-foreground",
        variant === "danger" && "border-critical/20 bg-critical/15 text-critical-foreground",
        variant === "info" && "border-info/20 bg-info/15 text-info-foreground",
        variant === "selected" && "border-selected-border/40 bg-selected text-brand-hover",
        variant === "outline" && "border-border bg-transparent text-text-muted",
        className
      )}
      {...props}
    />
  );
}
