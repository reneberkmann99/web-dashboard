"use client";

import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useNavigation } from "@/components/navigation/navigation-context";

/**
 * Design-system breadcrumbs backed by the persistent navigation trail.
 *
 * The trail is the user's investigation path (not a static hierarchy). Every
 * non-current segment is a real link (keyboard-accessible, right-clickable)
 * that returns to that exact previous context and truncates the trail. The
 * current segment is non-clickable. On narrow screens the middle segments
 * collapse (root + current stay visible).
 */
export function Breadcrumbs({ className }: { className?: string }): React.JSX.Element | null {
  const { stack, goBreadcrumb } = useNavigation();
  if (stack.length === 0) return null;

  const lastIndex = stack.length - 1;

  return (
    <nav aria-label="Breadcrumb" className={cn("flex flex-wrap items-center gap-1 text-sm", className)}>
      {stack.map((entry, index) => {
        const last = index === lastIndex;
        const middle = index > 0 && !last;
        return (
          <span key={`${entry.url}-${index}`} className="flex items-center gap-1">
            {index > 0 && <ChevronRight size={13} className="shrink-0 text-text-subtle" />}
            {middle && index === 1 && <span className="md:hidden" aria-hidden="true">…</span>}
            {last ? (
              <span className="max-w-52 truncate font-medium text-text" aria-current="page">
                {entry.label}
              </span>
            ) : (
              <a
                href={entry.url}
                onClick={(event) => {
                  event.preventDefault();
                  goBreadcrumb(index);
                }}
                className={cn(
                  "max-w-52 truncate text-text-muted transition-colors hover:text-text focus:outline-none focus:ring-2 focus:ring-focus",
                  middle && "hidden md:inline-flex"
                )}
              >
                {entry.label}
              </a>
            )}
          </span>
        );
      })}
    </nav>
  );
}
