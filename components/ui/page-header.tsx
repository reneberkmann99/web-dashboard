import * as React from "react";
import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  back,
  className
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  eyebrow?: React.ReactNode;
  actions?: React.ReactNode;
  back?: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <header className={cn("flex flex-wrap items-end justify-between gap-4", className)}>
      <div className="min-w-0">
        {back}
        {eyebrow && <div className="eyebrow mb-1">{eyebrow}</div>}
        <h1 className="page-title break-words">{title}</h1>
        {description && <div className="mt-1 text-text-muted">{description}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
