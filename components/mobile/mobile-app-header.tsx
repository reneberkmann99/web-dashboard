"use client";

import { usePathname } from "next/navigation";
import { ChevronLeft, EllipsisVertical, Search, SlidersHorizontal } from "lucide-react";
import { useNavigation } from "@/components/navigation/navigation-context";
import { NoderaftLogo } from "@/components/brand/noderaft-logo";
import { cn } from "@/lib/utils";

/**
 * Mobile app header (design §01/§02/§04/§05) — one 52px row:
 *
 *   [ mark ] [ back? ] [ screen title ]          [ contextual ] [ avatar ]
 *
 * Stable across screens: the mark and avatar are always present; the
 * contextual control is search (Overview/Workloads/Nodes/Containers), the
 * Filter pill (Activity), or overflow ellipsis (container detail). Page
 * titles/descriptions scroll away — only this row is pinned.
 */
export function MobileAppHeader({
  session,
  onAccountOpen
}: {
  session: { displayName: string; email: string; role: string; clientAccountName: string | null };
  onAccountOpen: () => void;
}): React.JSX.Element {
  const pathname = usePathname();
  const { stack, rootKey, goBreadcrumb, mobileReturn, goRoot } = useNavigation();

  const last = stack[stack.length - 1];
  const title = last?.label ?? "Noderaft";
  // Details (resources) render mono 13px like the design's container-detail
  // header; roots render the 16px/600 sans title.
  const titleMono = last?.kind === "resource" || /\/containers\/[^/]+\/[^/]+$/.test(pathname);
  const canBack = stack.length > 1 || mobileReturn !== null;

  const onBack = (): void => {
    if (stack.length > 1) {
      goBreadcrumb(stack.length - 2);
    } else if (mobileReturn) {
      const target = mobileReturn;
      goRoot(target);
    }
  };

  const isContainerDetail = /\/containers\/[^/]+\/[^/]+$/.test(pathname);
  const isActivity = rootKey === "activity";
  const showSearch = !isActivity && !isContainerDetail;

  return (
    <header className="mobile-header sticky top-0 z-30 flex flex-none items-center gap-3 border-b border-border bg-surface-hull/96 px-4 backdrop-blur md:hidden safe-top">
      <NoderaftLogo compact priority className="h-[30px] w-[30px] flex-none rounded-[9px] border border-brand/35 bg-surface-deck p-[5px]" />
      {canBack && (
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="grid h-11 w-9 flex-none place-items-center rounded-control text-text-muted transition-colors hover:text-text focus:outline-none focus:ring-2 focus:ring-focus"
        >
          <ChevronLeft size={22} />
        </button>
      )}
      <p
        className={cn(
          "min-w-0 flex-1 truncate",
          titleMono ? "font-mono text-[13px] text-text" : "text-base font-semibold tracking-[-0.01em] text-text"
        )}
      >
        {title}
      </p>

      {isActivity && (
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent("noderaft:open-activity-filter"))}
          aria-label="Open filters"
          className="inline-flex h-[34px] flex-none items-center gap-1.5 rounded-[9px] border border-border bg-surface-raised px-2.5 text-[13px] text-text-muted transition-colors hover:text-text focus:outline-none focus:ring-2 focus:ring-focus"
        >
          <SlidersHorizontal size={13} />
          Filter
        </button>
      )}
      {isContainerDetail && (
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent("noderaft:open-container-overflow"))}
          aria-label="Container actions"
          className="grid h-11 w-9 flex-none place-items-center rounded-control text-text-muted transition-colors hover:text-text focus:outline-none focus:ring-2 focus:ring-focus"
        >
          <EllipsisVertical size={20} />
        </button>
      )}
      {showSearch && (
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent("noderaft:open-search"))}
          aria-label="Open search"
          className="grid h-11 w-9 flex-none place-items-center rounded-control text-text-muted transition-colors hover:text-text focus:outline-none focus:ring-2 focus:ring-focus"
        >
          <Search size={19} />
        </button>
      )}
      <button
        type="button"
        onClick={onAccountOpen}
        aria-label="Open account sheet"
        className="grid h-8 w-8 flex-none place-items-center rounded-full border border-border bg-surface-raised font-mono text-[13px] text-brand focus:outline-none focus:ring-2 focus:ring-focus"
      >
        {(session.displayName || session.email || "?").charAt(0).toUpperCase()}
      </button>
    </header>
  );
}
