"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

/**
 * Canonical mobile resource-card family (design §02/§06/§19).
 *
 * One card shell, used for Workloads / Containers / Nodes / Clients / Users:
 *  - title line: human labels wrap normally, technical identifiers use
 *    `.mono-break` (word-break: break-all) — never expand the page width
 *  - status row: compact badges/chips + mono context (node, client, host)
 *  - optional mono metric strip separated by a hairline (cpu · mem · restarts
 *    · uptime)
 *  - optional attention dot / bar
 * The whole card is a button when `onClick` is provided (44px+ targets).
 */

export function MobileResourceCard({
  title,
  titleMono = true,
  subtitle,
  status,
  context,
  metrics,
  footer,
  attention,
  dimmed = false,
  onClick,
  onKeyDown,
  className,
  "aria-label": ariaLabel
}: {
  title: React.ReactNode;
  titleMono?: boolean;
  subtitle?: React.ReactNode;
  /** Right-aligned badge/chip row (e.g. health chip). */
  status?: React.ReactNode;
  /** Mono context line under the title, e.g. "Main VPS". */
  context?: React.ReactNode;
  /** Mono metric strip, e.g. ["1.4% cpu", "412 MiB", "0 restarts", "12d up"]. */
  metrics?: React.ReactNode;
  /** Extra footer content (borders/rows below the metric strip). */
  footer?: React.ReactNode;
  /** Attention dot in the top-right corner. */
  attention?: "ok" | "warn" | "bad" | "muted";
  /** Visually de-emphasize (stopped containers). */
  dimmed?: boolean;
  onClick?: (event: React.MouseEvent) => void;
  onKeyDown?: (event: React.KeyboardEvent) => void;
  className?: string;
  "aria-label"?: string;
}): React.JSX.Element {
  const dot =
    attention === "ok"
      ? "bg-success"
      : attention === "warn"
        ? "bg-warning"
        : attention === "bad"
          ? "bg-critical"
          : attention === "muted"
            ? "bg-text-subtle"
            : null;

  const inner = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p
          className={cn(
            "min-w-0 text-[13.5px] leading-[19px]",
            titleMono ? "font-mono text-text mono-break" : "font-medium text-text",
            dimmed && "text-text-muted"
          )}
        >
          {title}
        </p>
        {dot && <span className={cn("mt-[7px] h-[5px] w-[5px] flex-none rounded-full", dot)} aria-hidden="true" />}
      </div>
      {(status || context) && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {status}
          {context && <span className="font-mono text-[11px] text-text-subtle">{context}</span>}
        </div>
      )}
      {metrics && (
        <div className="mt-3 border-t border-border/60 pt-[11px]">
          <div className="flex justify-between gap-3 font-mono text-[11px] text-text-muted">{metrics}</div>
        </div>
      )}
      {footer}
    </>
  );

  const shell = cn(
    "rounded-[12px] border border-border bg-surface-deck p-3.5 text-left transition-colors",
    dimmed && "opacity-75",
    onClick && "w-full cursor-pointer hover:border-selected-border/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
    className
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        onKeyDown={onKeyDown}
        aria-label={ariaLabel}
        className={shell}
      >
        {inner}
      </button>
    );
  }
  return (
    <div className={shell} aria-label={ariaLabel}>
      {inner}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Metric strip — horizontally scrolling metric cards (design §18/R5).  */
/* 112px cards on roots, 106px on detail; one card peeks at the edge.   */
/* ------------------------------------------------------------------ */

export function MobileMetricCard({
  label,
  value,
  sub,
  valueClass = "text-[26px]"
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  valueClass?: string;
}): React.JSX.Element {
  return (
    <div className="w-[112px] rounded-[12px] border border-border bg-surface-deck px-3.5 py-3.5">
      <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">{label}</p>
      <p className={cn("mt-2.5 font-mono font-medium leading-none tabular-nums", valueClass)}>{value}</p>
      {sub && <p className="mt-1.5 text-[11px] text-text-muted">{sub}</p>}
    </div>
  );
}

export function MobileMetricStrip({
  children,
  className,
  peek = true,
  cardWidth
}: {
  children: React.ReactNode;
  className?: string;
  /** Render a peeking card at the right edge so the scroll affordance is visible. */
  peek?: boolean;
  /** When provided, cards get this width (e.g. 106px on container detail). */
  cardWidth?: number;
}): React.JSX.Element {
  return (
    <div className={cn("relative", className)}>
      <div className="metric-strip -mx-4 px-4" data-metric-strip>
        {cardWidth
          ? React.Children.map(children, (child) =>
              React.isValidElement(child)
                ? React.cloneElement(child as React.ReactElement<{ className?: string }>, {
                    className: cn(
                      (child.props as { className?: string }).className,
                      "!w-[106px]"
                    )
                  })
                : child
            )
          : children}
        {peek && <div className="w-9 flex-none" aria-hidden="true" />}
      </div>
      <div
        className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-surface-hull to-transparent"
        aria-hidden="true"
      />
    </div>
  );
}

/** Compact status chip used in cards (design: 11px, colored, dot). */
export function CardChip({
  children,
  tone = "neutral",
  dot
}: {
  children: React.ReactNode;
  tone?: "success" | "warning" | "danger" | "neutral" | "brand";
  dot?: boolean;
}): React.JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-[5px] rounded-md px-2 py-[3px] text-[11px] leading-4",
        tone === "success" && "bg-success/16 text-success-foreground",
        tone === "warning" && "bg-warning/18 text-warning-foreground",
        tone === "danger" && "bg-critical/16 text-critical-foreground",
        tone === "neutral" && "bg-surface-raised text-text-muted",
        tone === "brand" && "bg-brand/14 text-brand-hover"
      )}
    >
      {dot && (
        <span
          className={cn(
            "h-[5px] w-[5px] rounded-full",
            tone === "success" && "bg-success",
            tone === "warning" && "bg-warning",
            tone === "danger" && "bg-critical",
            tone === "brand" && "bg-brand",
            tone === "neutral" && "bg-text-subtle"
          )}
          aria-hidden="true"
        />
      )}
      {children}
    </span>
  );
}

/** Small icon tile used at the left of node/client cards (design §06). */
export function CardIconTile({
  icon: Icon,
  tone = "brand"
}: {
  icon: LucideIcon;
  tone?: "brand" | "muted";
}): React.JSX.Element {
  return (
    <span className="grid h-[38px] w-[38px] flex-none place-items-center rounded-[11px] bg-surface-raised">
      <Icon size={18} className={tone === "brand" ? "text-brand" : "text-text-muted"} />
    </span>
  );
}

/** 5px resource meter used on node cards (design §06). */
export function CardMeter({
  label,
  value,
  percent,
  tone = "quiet"
}: {
  label: string;
  value: string;
  percent: number;
  tone?: "quiet" | "warning";
}): React.JSX.Element {
  return (
    <div>
      <div className="flex justify-between font-mono text-[11px] text-text-muted">
        <span>{label}</span>
        <span>{value}</span>
      </div>
      <div className="mt-1.5 h-[5px] overflow-hidden rounded-[3px] bg-surface-raised">
        <div
          className={cn("h-full rounded-[3px]", tone === "warning" ? "bg-warning" : "bg-brand")}
          style={{ width: `${Math.min(Math.max(percent, 0), 100)}%` }}
        />
      </div>
    </div>
  );
}
