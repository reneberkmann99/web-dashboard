import * as React from "react";
import { cn } from "@/lib/utils";

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  return (
    <input
      className={cn(
        "h-10 w-full rounded-md border border-border bg-panelAlt px-3 py-2 text-sm placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent",
        className
      )}
      {...props}
    />
  );
}
