"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  currentUrl,
  loadContext,
  saveContext,
  deriveFallback,
  extendStack,
  type NavContextState,
  type NavEntry,
  type NavRootKey,
  type RootDef
} from "@/lib/navigation";

export type { NavEntry, NavRootKey };

type PushInput = { url: string; label: string; type?: string; id?: string };

type NavApi = {
  rootKey: NavRootKey;
  rootHref: string;
  stack: NavEntry[];
  pushResource: (input: PushInput) => void;
  goRoot: (def: RootDef) => void;
  goBreadcrumb: (index: number) => void;
  setTab: (tabLabel: string | null, url: string) => void;
  renameCurrent: (label: string) => void;
  /** Root to return to after an account-sheet destination (mobile back chevron). */
  mobileReturn: RootDef | null;
  setMobileReturn: (def: RootDef | null) => void;
};

const MOBILE_RETURN_KEY = "noderaft:mobile-return";

function readMobileReturn(): RootDef | null {
  try {
    const raw = window.sessionStorage.getItem(MOBILE_RETURN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RootDef;
    if (parsed && typeof parsed.href === "string") return parsed;
    return null;
  } catch {
    return null;
  }
}

function writeMobileReturn(def: RootDef | null): void {
  try {
    if (def) window.sessionStorage.setItem(MOBILE_RETURN_KEY, JSON.stringify(def));
    else window.sessionStorage.removeItem(MOBILE_RETURN_KEY);
  } catch {
    /* storage unavailable — navigation still works */
  }
}

const NavigationContext = createContext<NavApi | null>(null);

function defaultContext(pathname: string): NavContextState {
  return {
    rootKey: "overview",
    rootHref: pathname.startsWith("/client") || pathname.startsWith("/organization") ? "/organization" : "/admin",
    stack: [{ kind: "root", label: "Overview", url: pathname.startsWith("/client") || pathname.startsWith("/organization") ? "/organization" : "/admin" }]
  };
}

/** Identity used to build the Account settings breadcrumb — see accountContext below. */
export type AccountNavContext = { displayName: string; overviewHref: string };

/**
 * `/account` has no sidebar item — it's reached from the user menu, not a
 * root nav destination (design review round 2, P0 §2: the route-to-nav
 * mapping needs an explicit "no match" case rather than falling back to the
 * index route, which previously left the breadcrumb reading "Overview" and
 * the sidebar highlighting Overview even though the user was on Account).
 * `rootHref: "/account"` matches no sidebar href, so no nav item renders
 * active; the breadcrumb reads "{name} › Account settings".
 */
function deriveAccountContext(pathname: string, account: AccountNavContext): NavContextState | null {
  if (pathname !== "/account" && !pathname.startsWith("/account/")) return null;
  return {
    rootKey: "overview",
    rootHref: "/account",
    stack: [
      { kind: "root", label: account.displayName, url: account.overviewHref },
      { kind: "resource", label: "Account settings", url: pathname }
    ]
  };
}

export function NavigationProvider({ children, accountContext }: { children: React.ReactNode; accountContext?: AccountNavContext }): React.JSX.Element {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const url = currentUrl(pathname, searchParams.toString());

  const deriveRouteContext = useCallback(
    (path: string, search: string): NavContextState | null =>
      (accountContext && deriveAccountContext(path, accountContext)) ?? deriveFallback(path, search),
    [accountContext]
  );

  // Deterministic initial render (route-derived only — no sessionStorage) so
  // server and client hydration agree. sessionStorage is restored in an effect.
  const [ctx, setCtx] = useState<NavContextState>(
    () => deriveRouteContext(pathname, searchParams.toString()) ?? defaultContext(pathname)
  );

  // On any route change (push / replace / back / forward) restore the context
  // recorded for this exact URL, or fall back to route-derived. Account is
  // always route-derived (never restored from a stale stored trail, e.g. one
  // saved by a session that hit this route before the P0 fix above) — it has
  // no meaningful "previous state" to return to since it isn't a root.
  const isAccountRoute = Boolean(accountContext) && (pathname === "/account" || pathname.startsWith("/account/"));
  useEffect(() => {
    const restored = isAccountRoute
      ? deriveRouteContext(pathname, searchParams.toString()) ?? defaultContext(pathname)
      : loadContext(url) ?? deriveRouteContext(pathname, searchParams.toString()) ?? defaultContext(pathname);
    setCtx(restored);
  }, [url, deriveRouteContext, isAccountRoute, pathname, searchParams]);

  const pushResource = useCallback(
    (input: PushInput) => {
      const entry: NavEntry = { kind: "resource", label: input.label, url: input.url, type: input.type, id: input.id };
      setCtx((prev) => {
        const stack = extendStack(prev.stack, entry);
        const next = { rootKey: prev.rootKey, rootHref: prev.rootHref, stack };
        saveContext(input.url, next);
        return next;
      });
      router.push(input.url);
    },
    [router]
  );

  const [mobileReturn, setMobileReturnState] = useState<RootDef | null>(() =>
    typeof window === "undefined" ? null : readMobileReturn()
  );

  const setMobileReturn = useCallback((def: RootDef | null) => {
    setMobileReturnState(def);
    writeMobileReturn(def);
  }, []);

  const goRoot = useCallback(
    (def: RootDef) => {
      const next: NavContextState = { rootKey: def.key, rootHref: def.href, stack: [{ kind: "root", label: def.label, url: def.href }] };
      saveContext(def.href, next);
      setCtx(next);
      // Explicitly choosing a root clears any pending mobile sheet return target.
      setMobileReturn(null);
      router.push(def.href);
    },
    [router, setMobileReturn]
  );

  const goBreadcrumb = useCallback(
    (index: number) => {
      const target = ctx.stack[index];
      if (!target) return;
      const stack = ctx.stack.slice(0, index + 1);
      const next = { rootKey: ctx.rootKey, rootHref: ctx.rootHref, stack };
      saveContext(target.url, next);
      setCtx(next);
      router.push(target.url);
    },
    [ctx, router]
  );

  const setTab = useCallback(
    (tabLabel: string | null, tabUrl: string) => {
      setCtx((prev) => {
        // Drop any trailing tab entry, then append the new tab (unless default).
        const withoutTab = prev.stack.filter((e, i) => !(e.kind === "tab" && i === prev.stack.length - 1));
        const stack = tabLabel ? [...withoutTab, { kind: "tab" as const, label: tabLabel, url: tabUrl }] : withoutTab;
        const next = { rootKey: prev.rootKey, rootHref: prev.rootHref, stack };
        saveContext(tabUrl, next);
        return next;
      });
      router.replace(tabUrl, { scroll: false });
    },
    [router]
  );

  const renameCurrent = useCallback(
    (label: string) => {
      setCtx((prev) => {
        const index = (() => {
          for (let i = prev.stack.length - 1; i >= 0; i--) {
            if (prev.stack[i].kind === "resource") return i;
          }
          return -1;
        })();
        if (index === -1 || prev.stack[index].label === label) {
          // No change — return the same state so React bails out and the
          // detail-page effect that calls renameCurrent cannot loop.
          return prev;
        }
        const stack = [...prev.stack];
        stack[index] = { ...stack[index], label };
        const next = { ...prev, stack };
        saveContext(url, next);
        return next;
      });
    },
    [url]
  );

  const value = useMemo<NavApi>(
    () => ({
      rootKey: ctx.rootKey,
      rootHref: ctx.rootHref,
      stack: ctx.stack,
      pushResource,
      goRoot,
      goBreadcrumb,
      setTab,
      renameCurrent,
      mobileReturn,
      setMobileReturn
    }),
    [ctx, pushResource, goRoot, goBreadcrumb, setTab, renameCurrent, mobileReturn, setMobileReturn]
  );

  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

export function useNavigation(): NavApi {
  const ctx = useContext(NavigationContext);
  if (!ctx) {
    throw new Error("useNavigation must be used within a NavigationProvider");
  }
  return ctx;
}

/** Variant that returns null outside a provider (used by shared hooks). */
export function useOptionalNavigation(): NavApi | null {
  return useContext(NavigationContext);
}

/**
 * Convenience hook for resource rows/cards: pushes a context-preserving
 * resource navigation when the provider is present, otherwise falls back to a
 * plain router.push (e.g. when rendered outside the dashboard shell).
 */
export function useResourceNavigation(): (input: { url: string; label: string; type?: string; id?: string }) => void {
  const nav = useOptionalNavigation();
  const router = useRouter();
  return useCallback(
    (input) => {
      if (nav) nav.pushResource(input);
      else router.push(input.url);
    },
    [nav, router]
  );
}
