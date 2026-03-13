import * as React from "react";
import { cn } from "@/lib/utils";

export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>): React.JSX.Element {
  return (
    <textarea
      className={cn(
        "w-full rounded-md border border-border bg-panelAlt px-3 py-2 text-sm placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent",
        className
      )}
      {...props}
    />
  );
}
