"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

/**
 * Unsaved-changes protection for editors.
 *
 * Extends the existing `beforeunload` dirty-check to in-app navigation: any
 * click on an in-app link (sidebar, breadcrumb, back link) while the editor is
 * dirty is intercepted in the capture phase and routed through a confirm
 * dialog. Programmatic navigation goes through `guardedNavigate`.
 *
 * No prompt is shown when there are no unsaved changes.
 */
export function useUnsavedGuard(dirty: boolean): {
  guardedNavigate: (href: string) => void;
  /** Ask for confirmation before running an arbitrary destructive-to-edits action. */
  guardedAction: (action: () => void) => void;
  dialog: React.JSX.Element | null;
} {
  const router = useRouter();
  const [pending, setPending] = useState<(() => void) | null>(null);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // Native reload/close protection.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      if (dirtyRef.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // In-app link interception (sidebar / breadcrumb / any <a href="/...">).
  useEffect(() => {
    const onClick = (event: MouseEvent): void => {
      if (!dirtyRef.current) return;
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      const target = event.target as HTMLElement | null;
      const anchor = target?.closest?.("a");
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (!href || !href.startsWith("/") || anchor.getAttribute("target") === "_blank") return;
      if (anchor.dataset.allowUnsaved === "true") return;
      if (href === window.location.pathname + window.location.search) return;

      event.preventDefault();
      event.stopPropagation();
      setPending(() => () => router.push(href));
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [router]);

  const guardedNavigate = useCallback(
    (href: string) => {
      if (!dirtyRef.current) {
        router.push(href);
        return;
      }
      setPending(() => () => router.push(href));
    },
    [router]
  );

  const guardedAction = useCallback((action: () => void) => {
    if (!dirtyRef.current) {
      action();
      return;
    }
    setPending(() => action);
  }, []);

  const dialog = pending ? (
    <ConfirmDialog
      open
      onClose={() => setPending(null)}
      onConfirm={() => {
        const run = pending;
        setPending(null);
        run();
      }}
      title="Discard unsaved changes?"
      impact="You have configuration changes that have not been saved as a revision. Leaving now discards them. Nothing has been deployed."
      confirmLabel="Discard and leave"
      danger
    />
  ) : null;

  return { guardedNavigate, guardedAction, dialog };
}
