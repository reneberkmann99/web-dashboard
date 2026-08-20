"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useOptionalNavigation } from "@/components/navigation/navigation-context";

const STORAGE_PREFIX = "noderaft:view:";
const RETURN_PREFIX = "noderaft:return:";

export function useStoredViewState<T>(key: string | null, initialValue: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const storageKey = key ? `${STORAGE_PREFIX}${key}` : null;
  const [value, setValue] = useState<T>(initialValue);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!storageKey) {
      setReady(true);
      return;
    }
    try {
      const stored = window.sessionStorage.getItem(storageKey);
      if (stored !== null) setValue(JSON.parse(stored) as T);
    } catch {
      // A malformed or unavailable session store should never break a page.
    } finally {
      setReady(true);
    }
  }, [storageKey]);

  useEffect(() => {
    if (!ready || !storageKey) return;
    try {
      window.sessionStorage.setItem(storageKey, JSON.stringify(value));
    } catch {
      // Browsers may disable storage in private/restricted contexts.
    }
  }, [ready, storageKey, value]);

  return [value, setValue];
}

function tabParamValue(tab: string): string {
  return tab.toLowerCase().replaceAll(" ", "-");
}

export function useDetailTab<T extends string>(tabs: readonly T[], defaultTab: T): [T, (tab: T) => void] {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const nav = useOptionalNavigation();
  const requested = searchParams.get("tab");
  const active = useMemo(
    () => tabs.find((tab) => tabParamValue(tab) === requested) ?? defaultTab,
    [defaultTab, requested, tabs]
  );

  const setActive = useCallback(
    (tab: T) => {
      const params = new URLSearchParams(searchParams.toString());
      if (tab === defaultTab) params.delete("tab");
      else params.set("tab", tabParamValue(tab));
      const query = params.toString();
      const url = query ? `${pathname}?${query}` : pathname;
      if (nav) {
        // Record the tab as a trail segment (default tab clears it) and navigate.
        nav.setTab(tab === defaultTab ? null : tab, url);
      } else {
        router.replace(url, { scroll: false });
      }
    },
    [defaultTab, nav, pathname, router, searchParams]
  );

  return [active, setActive];
}

export function rememberResourceNavigation(destination: string): void {
  if (typeof window === "undefined") return;
  try {
    const destinationPath = new URL(destination, window.location.origin).pathname;
    const current = `${window.location.pathname}${window.location.search}`;
    window.sessionStorage.setItem(`${RETURN_PREFIX}${destinationPath}`, current);
  } catch {
    // Navigation still works when session storage is unavailable.
  }
}

export function readRememberedReturn(pathname: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(`${RETURN_PREFIX}${pathname}`);
  } catch {
    return null;
  }
}

// A Back/Forward navigation fires `popstate` (before the new route's effects
// run). A fresh navigation (sidebar Link / router.push) does not. We track the
// most recent navigation type in a module singleton so scroll restoration can
// distinguish "return to where I was" from "open a new page at the top".
let popListenerRegistered = false;
let pendingPopNavigation = false;

function ensurePopListener(): void {
  if (typeof window === "undefined" || popListenerRegistered) return;
  popListenerRegistered = true;
  window.addEventListener("popstate", () => {
    pendingPopNavigation = true;
  });
}

export function ViewStateRestoration(): null {
  const pathname = usePathname();

  useEffect(() => {
    ensurePopListener();
    const restoreFromPop = pendingPopNavigation;
    pendingPopNavigation = false;

    const key = `${STORAGE_PREFIX}scroll:${pathname}`;
    const saved = Number(window.sessionStorage.getItem(key) ?? "0");
    let frame = 0;
    let attempts = 0;
    let cancelled = false;

    const restore = (): void => {
      if (cancelled || !Number.isFinite(saved) || saved <= 0) return;
      window.scrollTo({ top: saved, behavior: "auto" });
      attempts += 1;
      if (Math.abs(window.scrollY - saved) > 2 && attempts < 30) {
        window.setTimeout(restore, 50);
      }
    };

    if (restoreFromPop) {
      frame = window.requestAnimationFrame(restore);
    } else {
      // Fresh navigation always starts at the top.
      window.scrollTo({ top: 0, behavior: "auto" });
    }

    const onScroll = (): void => {
      window.sessionStorage.setItem(key, String(Math.round(window.scrollY)));
    };
    window.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      window.sessionStorage.setItem(key, String(Math.round(window.scrollY)));
      window.removeEventListener("scroll", onScroll);
    };
  }, [pathname]);

  return null;
}
