"use client";

import { useEffect } from "react";

/**
 * Minimal focus trap for dialogs/overlays: keeps Tab/Shift+Tab cycling within
 * the container, returns focus to the previously-focused element on unmount
 * when `restoreFocus` is set. Escape handling stays with the caller (so each
 * overlay can decide its own close semantics).
 */
export function useFocusTrap(
  containerRef: React.RefObject<HTMLElement | null>,
  active: boolean,
  restoreFocus = true
): void {
  useEffect(() => {
    if (!active) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Tab") return;
      const container = containerRef.current;
      if (!container) return;

      const focusables = Array.from(
        container.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);

      if (focusables.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const current = document.activeElement as HTMLElement | null;

      if (event.shiftKey) {
        if (!current || current === first || !container.contains(current)) {
          event.preventDefault();
          last.focus();
        }
      } else if (!current || current === last || !container.contains(current)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);

    // Initial focus: the container itself (focusable via tabIndex=-1) so the
    // dialog is announced; the caller may then move focus to a specific field.
    const container = containerRef.current;
    if (container && !container.contains(document.activeElement)) {
      container.focus();
    }

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (restoreFocus && previouslyFocused instanceof HTMLElement) {
        previouslyFocused.focus();
      }
    };
  }, [containerRef, active, restoreFocus]);
}
