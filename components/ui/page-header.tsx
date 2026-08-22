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
  "/organizations",
  "/admin/attention",
  "/admin/activity",
  "/admin/compose",
  "/admin/settings/users",
  "/admin/settings/notifications",
  "/client",
  "/client/workloads",
  "/client/containers",
  "/client/activity",
  "/client/team",
  "/organization",
  "/organization/workloads",
  "/organization/containers",
  "/organization/attention",
  "/organization/activity",
  "/organization/members",
  "/organization/settings"
]);

function mobileModeFor(pathname: string): "hidden" | "compact" {
  return MOBILE_HIDDEN_ROOTS.has(pathname) ? "hidden" : "compact";
}

export function PageHeader({
  title,
  count,
  description,
  eyebrow,
  actions,
  back,
  className,
  mobile = "auto"
}: {
  title: React.ReactNode;
  count?: number;
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
      <header className={cn("flex min-h-[58px] flex-wrap items-end justify-between gap-4", mode === "hidden" && "max-md:hidden", className)} data-page-header>
        <div className="min-w-0">
          {/* Desktop breadcrumbs live persistently in the 52px top bar. */}
          {back && <div className="hidden">{back}</div>}
          {eyebrow && <div className="sr-only">{eyebrow}</div>}
          <h1
            className={cn(
              "flex flex-wrap items-baseline gap-2 break-words",
              mode === "compact"
                ? "text-lg font-semibold leading-tight tracking-[-0.01em] md:text-[26px] md:tracking-[-0.02em]"
                : "text-[26px] font-semibold leading-[1.15] tracking-[-0.02em]"
            )}
          >
            <span>{title}</span>
            {count !== undefined && <span className="font-mono text-base font-normal tabular-nums text-text-subtle">{count}</span>}
          </h1>
          {description && (
            <div className={cn("mt-1 text-[13.5px] leading-5 text-text-muted", mode === "compact" && "max-md:hidden")}>{description}</div>
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
