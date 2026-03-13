import * as React from "react";
import { cn } from "@/lib/utils";

export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>): React.JSX.Element {
  return (
    <select
      className={cn(
        "h-10 w-full rounded-md border border-border bg-panelAlt px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent",
        className
      )}
      {...props}
    />
  );
}
