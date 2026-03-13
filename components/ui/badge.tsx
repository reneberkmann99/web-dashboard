import * as React from "react";
import { cn } from "@/lib/utils";

export function Badge({
  className,
  variant = "default",
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & {
  variant?: "default" | "success" | "warning" | "danger";
}): React.JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium",
        variant === "default" && "bg-panelAlt text-text",
        variant === "success" && "bg-success/20 text-green-300",
        variant === "warning" && "bg-warning/20 text-amber-300",
        variant === "danger" && "bg-danger/20 text-red-300",
        className
      )}
      {...props}
    />
  );
}
