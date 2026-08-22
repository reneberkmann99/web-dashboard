"use client";

import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

/**
 * Pinned container action bar (design §04/§11).
 *
 * Fixed above the bottom tab bar (which is ~60px + safe-area), inside the
 * thumb zone. State-aware: the page only supplies valid actions (running →
 * Restart/Stop, stopped → Start), disables everything while an operation is
 * in flight or the node is offline, and never offers an invalid action.
 *
 * Layout: the first action is a full-width 50px primary button; remaining
 * actions render as 50px icon squares (design: Restart + Stop + Logs).
 * Renders nothing above the mobile breakpoint (desktop keeps inline actions).
 */
export function MobileActionBar({
  actions,
  className
}: {
  actions: Array<{
    key: string;
    label: string;
    icon?: LucideIcon;
    variant?: "primary" | "danger" | "secondary";
    disabled?: boolean;
    onClick: () => void;
  }>;
  className?: string;
}): React.JSX.Element | null {
  if (actions.length === 0) return null;
  const [first, ...rest] = actions;

  return (
    <div
      className={cn(
        "fixed inset-x-0 z-40 border-t border-border bg-surface-deck/98 backdrop-blur md:hidden",
        "bottom-[calc(60px+env(safe-area-inset-bottom))] px-4 pb-3 pt-3",
        className
      )}
      data-mobile-action-bar
    >
      <div className="flex gap-2.5">
        <button
          type="button"
          onClick={first.onClick}
          disabled={first.disabled}
          className={cn(
            "inline-flex h-[50px] flex-1 items-center justify-center gap-2 rounded-[12px] text-[15px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-45",
            first.variant === "danger"
              ? "bg-critical text-white"
              : first.variant === "secondary"
                ? "border border-border bg-surface-raised text-text"
                : "bg-brand text-text-inverse hover:bg-brand-hover"
          )}
        >
          {first.icon && <first.icon size={17} />}
          {first.label}
        </button>
        {rest.map((action) => (
          <button
            key={action.key}
            type="button"
            onClick={action.onClick}
            disabled={action.disabled}
            aria-label={action.label}
            title={action.label}
            className={cn(
              "grid h-[50px] w-[50px] flex-none place-items-center rounded-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-45",
              action.variant === "danger"
                ? "border border-critical/40 bg-critical/8 text-critical-foreground"
                : action.variant === "secondary"
                  ? "border border-border bg-surface-raised text-text-muted"
                  : "bg-brand text-text-inverse"
            )}
          >
            {action.icon && <action.icon size={17} />}
          </button>
        ))}
      </div>
    </div>
  );
}
