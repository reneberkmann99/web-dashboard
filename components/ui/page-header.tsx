"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { DocumentTitle } from "@/components/brand/document-title";

/**
 * Page header. On mobile (<768px) the 52px app header carries the screen
 * name, so by default inventory roots collapse to actions-only and detail
 * pages render a compact title row (design §23 — no duplicated giant titles).
 * Pass `mobile="hidden" | "compact" | "auto"` to override.
 */

const MOBILE_HIDDEN_ROOTS = new Set([
  "/admin",
  "/admin/workloads",
  "/admin/containers",
  "/admin/nodes",
  "/admin/clients",
  "/admin/attention",
  "/admin/activity",
  "/admin/compose",
  "/admin/settings/users",
  "/admin/settings/notifications",
  "/client",
  "/client/workloads",
  "/client/containers",
  "/client/activity",
  "/client/team"
]);

function mobileModeFor(pathname: string): "hidden" | "compact" {
  return MOBILE_HIDDEN_ROOTS.has(pathname) ? "hidden" : "compact";
}

export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  back,
  className,
  mobile = "auto"
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  eyebrow?: React.ReactNode;
  actions?: React.ReactNode;
  back?: React.ReactNode;
  className?: string;
  /** "auto" derives from the route: roots hide, details stay compact. */
  mobile?: "auto" | "hidden" | "compact";
}): React.JSX.Element {
  const pathname = usePathname();
  const mode = mobile === "auto" ? mobileModeFor(pathname) : mobile;

  return (
    <>
      {typeof title === "string" && <DocumentTitle title={title} />}
      <header className={cn("flex flex-wrap items-end justify-between gap-4", mode === "hidden" && "max-md:hidden", className)}>
        <div className="min-w-0">
          {back && <div className="max-md:hidden">{back}</div>}
          {eyebrow && <div className={cn("eyebrow mb-1", mode === "compact" && "max-md:hidden")}>{eyebrow}</div>}
          <h1
            className={cn(
              "break-words",
              mode === "compact"
                ? "text-lg font-semibold leading-tight tracking-[-0.01em] md:text-[clamp(1.875rem,3vw,2.25rem)] md:tracking-[-0.03em]"
                : "page-title"
            )}
          >
            {title}
          </h1>
          {description && (
            <div className={cn("mt-1 text-text-muted", mode === "compact" && "max-md:hidden")}>{description}</div>
          )}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      {mode === "hidden" && actions && (
        <div className="flex flex-wrap items-center gap-2 md:hidden">{actions}</div>
      )}
    </>
  );
}
