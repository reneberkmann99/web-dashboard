"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  BellRing,
  Boxes,
  Container,
  Globe,
  LayoutDashboard,
  ChevronDown,
  Search,
  Server,
  ShieldAlert,
  Settings,
  Users,
  Workflow,
  PanelLeftClose,
  PanelLeftOpen
} from "lucide-react";
import { cn } from "@/lib/utils";
import { deriveFreshness } from "@/lib/freshness";
import { isClientRole } from "@/types/domain";
import { apiFetch } from "@/lib/fetcher";
import { CommandPalette } from "@/components/search/command-palette";
import { NoderaftLogo } from "@/components/brand/noderaft-logo";
import { Menu } from "@/components/ui/menu";
import { ViewStateRestoration } from "@/components/navigation/view-state";
import { NavigationProvider, useNavigation } from "@/components/navigation/navigation-context";
import { MobileAppHeader } from "@/components/mobile/mobile-app-header";
import { MobileBottomNav } from "@/components/mobile/mobile-bottom-nav";
import { AccountSheet } from "@/components/mobile/account-sheet";
import type { NavRootKey } from "@/lib/navigation";
import { Breadcrumbs } from "@/components/navigation/breadcrumbs";

type ShellSession = {
  displayName: string;
  email: string;
  role: string;
  clientAccountName: string | null;
};

type NavItem = { key: NavRootKey; href: string; label: string; icon: React.ComponentType<{ className?: string }> };

const ADMIN_NAV: NavItem[] = [
  { key: "overview", href: "/admin", label: "Overview", icon: LayoutDashboard },
  { key: "workloads", href: "/admin/workloads", label: "Workloads", icon: Boxes },
  { key: "containers", href: "/admin/containers", label: "Containers", icon: Container },
  { key: "attention", href: "/admin/attention", label: "Attention", icon: ShieldAlert },
  { key: "activity", href: "/admin/activity", label: "Activity", icon: Activity },
  { key: "nodes", href: "/admin/nodes", label: "Nodes", icon: Server },
  { key: "ingress", href: "/admin/infrastructure/ingress", label: "Ingress", icon: Globe },
  { key: "organizations", href: "/organizations", label: "Organizations", icon: Users },
  { key: "users", href: "/admin/settings/users", label: "All Users", icon: Users },
  { key: "alerting", href: "/admin/settings/notifications", label: "Alerting", icon: BellRing },
  { key: "platformSettings", href: "/admin/settings", label: "Platform Settings", icon: Settings }
];

const CLIENT_NAV: NavItem[] = [
  { key: "overview", href: "/organization", label: "Overview", icon: LayoutDashboard },
  { key: "workloads", href: "/organization/workloads", label: "Workloads", icon: Workflow },
  { key: "containers", href: "/organization/containers", label: "Containers", icon: Container },
  { key: "domains", href: "/organization/domains", label: "Domains", icon: Globe },
  { key: "attention", href: "/organization/attention", label: "Attention", icon: ShieldAlert },
  { key: "activity", href: "/organization/activity", label: "Activity", icon: Activity }
];

const CLIENT_ADMIN_NAV: NavItem[] = [
  { key: "members", href: "/organization/members", label: "Members", icon: Users },
  { key: "alerting", href: "/organization/settings/notifications", label: "Alerting", icon: BellRing },
  { key: "settings", href: "/organization/settings", label: "Settings", icon: Settings }
];

export type LayoutVariant = "wide" | "standard" | "full";

/**
 * Resolve a route to one of three intentional layout variants (no arbitrary
 * per-page max widths):
 *  - `wide`   inventory surfaces (Overview, Workloads, Nodes, Organizations, Attention, Activity)
 *  - `standard` detail / settings pages
 *  - `full`   logs / editors
 */
export function layoutVariantFor(pathname: string): LayoutVariant {
  if (
    pathname.includes("/deployment/edit") ||
    pathname.startsWith("/admin/containers/") ||
    pathname.startsWith("/client/containers/") ||
    pathname.startsWith("/organization/containers/")
  ) {
    return "full";
  }
  const wideRoutes = new Set([
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
    "/organization",
    "/organization/workloads",
    "/organization/containers",
    "/organization/attention",
    "/organization/activity",
    "/organization/members",
    "/organization/settings",
    "/organization/settings/notifications",
    // Legacy paths remain supported for bookmarked sessions.
    "/client",
    "/client/workloads",
    "/client/containers",
    "/client/activity",
    "/client/team",
    "/client/settings/notifications"
  ]);
  return wideRoutes.has(pathname) ? "wide" : "standard";
}

const VARIANT_CLASS: Record<LayoutVariant, string> = {
  wide: "max-w-[1536px]",
  standard: "max-w-7xl",
  full: "max-w-[1680px]"
};

export function contentWidthClass(pathname: string): string {
  return VARIANT_CLASS[layoutVariantFor(pathname)];
}

/** Container detail routes carry a pinned mobile action bar above the nav. */
export function hasPinnedContainerActions(pathname: string): boolean {
  return /(\/admin\/containers\/[^/]+\/[^/]+|\/client\/containers\/[^/]+)$/.test(pathname);
}

type ShellSummaryPayload = {
  freshAt: string | null;
  nodesOnline: number;
  nodesTotal: number;
  fleetSummary: {
    attentionIssues: number;
    nodesTotal: number;
    workloadsTotal: number;
    containersTotal: number;
  } | null;
};

export function DashboardShell({
  children,
  session
}: {
  children: React.ReactNode;
  session: ShellSession;
}): React.JSX.Element {
  const accountContext = {
    displayName: session.displayName || session.email,
    overviewHref: session.role === "ADMIN" ? "/admin" : "/organization"
  };
  return (
    <NavigationProvider accountContext={accountContext}>
      <DashboardShellInner session={session}>{children}</DashboardShellInner>
    </NavigationProvider>
  );
}

function DashboardShellInner({
  children,
  session
}: {
  children: React.ReactNode;
  session: ShellSession;
}): React.JSX.Element {
  const pathname = usePathname();
  const router = useRouter();
  const { rootHref, goRoot } = useNavigation();
  const isAdmin = session.role === "ADMIN";
  const isClientAdmin = session.role === "CLIENT" || session.role === "CLIENT_ADMIN";
  const navItems = isAdmin ? ADMIN_NAV : [...CLIENT_NAV, ...(isClientAdmin ? CLIENT_ADMIN_NAV : [])];
  const overviewHref = isAdmin ? "/admin" : "/organization";

  const [accountOpen, setAccountOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [freshnessNow, setFreshnessNow] = useState(() => Date.now());
  useEffect(() => {
    try {
      setSidebarCollapsed(window.sessionStorage.getItem("noderaft:desktop-sidebar-collapsed") === "1");
    } catch {
      /* storage unavailable */
    }
    const timer = window.setInterval(() => setFreshnessNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Attention badge for the mobile bottom tab (admins only). Uses the same
  // authoritative fleet summary as the Overview screen; refreshes slowly.
  const attentionQuery = useQuery({
    queryKey: ["shell-freshness", isAdmin ? "admin" : "organization"],
    queryFn: () => apiFetch<ShellSummaryPayload>("/api/shell/summary"),
    refetchInterval: 20_000
  });

  const fleetSummary = attentionQuery.data?.fleetSummary ?? null;
  const freshAtMs = attentionQuery.data?.freshAt ? new Date(attentionQuery.data.freshAt).getTime() : Number.NaN;
  const freshnessAge = Number.isFinite(freshAtMs) ? Math.max(0, Math.floor((freshnessNow - freshAtMs) / 1000)) : null;
  const freshness = deriveFreshness({
    ageSeconds: freshnessAge,
    queryError: attentionQuery.isError,
    nodesTotal: attentionQuery.data?.nodesTotal ?? null,
    nodesOnline: attentionQuery.data?.nodesOnline ?? null
  });

  const setCollapsed = (value: boolean): void => {
    setSidebarCollapsed(value);
    try {
      window.sessionStorage.setItem("noderaft:desktop-sidebar-collapsed", value ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
  };

  const navCount = (item: NavItem): number | null => {
    if (!fleetSummary) return null;
    if (item.key === "workloads") return fleetSummary.workloadsTotal;
    if (item.key === "containers") return fleetSummary.containersTotal;
    if (item.key === "nodes") return fleetSummary.nodesTotal;
    // A zero Attention badge is noise that trains people to ignore the badge —
    // hide it at zero, amber pill only once there's something to see (design
    // review round 2, consistency debts §06).
    if (item.key === "attention") return fleetSummary.attentionIssues > 0 ? fleetSummary.attentionIssues : null;
    return null;
  };

  const renderLink = (item: NavItem, Icon: NavItem["icon"]): React.JSX.Element => {
    const active = rootHref === item.href;
    return (
      <a
        href={item.href}
        onClick={(event) => {
          event.preventDefault();
          goRoot({ key: item.key, href: item.href, label: item.label });
        }}
        aria-current={active ? "page" : undefined}
        className={cn(
          "relative flex h-[38px] items-center rounded-control px-3 text-sm text-text-muted transition-colors hover:bg-surface-raised hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
          sidebarCollapsed ? "justify-center" : "gap-2.5",
          active && "bg-selected/70 text-text before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-brand"
        )}
        key={item.href}
        title={sidebarCollapsed ? item.label : undefined}
      >
        <Icon className={cn("h-4 w-4 shrink-0", active && "text-brand")} />
        {!sidebarCollapsed && <span>{item.label}</span>}
        {!sidebarCollapsed && navCount(item) !== null && (
          <span className={cn("ml-auto font-mono text-[11px] tabular-nums text-text-subtle", item.key === "attention" && navCount(item)! > 0 && "rounded bg-warning/15 px-1.5 py-0.5 text-warning-foreground")}>
            {navCount(item)}
          </span>
        )}
      </a>
    );
  };

  const pinnedActions = hasPinnedContainerActions(pathname);

  return (
    <div className={cn("min-h-screen md:grid", sidebarCollapsed ? "md:grid-cols-[64px_1fr]" : "md:grid-cols-[264px_1fr]")}>
      <aside className={cn("hidden border-b border-border bg-surface-deck md:sticky md:top-0 md:flex md:h-screen md:flex-col md:border-b-0 md:border-r", sidebarCollapsed ? "p-3" : "p-4")} data-sidebar-collapsed={sidebarCollapsed ? "true" : "false"}>
        <div className={cn("flex h-9 items-center", sidebarCollapsed ? "justify-center" : "justify-between")}>
        <a
          href={overviewHref}
          aria-label="Noderaft overview"
          onClick={(event) => {
            event.preventDefault();
            goRoot({ key: "overview", href: overviewHref, label: "Overview" });
          }}
          className="inline-flex rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <NoderaftLogo priority compact={sidebarCollapsed} className={sidebarCollapsed ? "h-[30px] w-[30px]" : "h-[30px] w-auto"} />
        </a>
        {!sidebarCollapsed && (
          <button type="button" onClick={() => setCollapsed(true)} aria-label="Collapse sidebar" className="grid h-8 w-8 place-items-center rounded-control text-text-subtle hover:bg-surface-raised hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
            <PanelLeftClose size={15} />
          </button>
        )}
        </div>

        {sidebarCollapsed && (
          <button type="button" onClick={() => setCollapsed(false)} aria-label="Expand sidebar" title="Expand sidebar" className="mt-3 grid h-8 w-full place-items-center rounded-control text-text-subtle hover:bg-surface-raised hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
            <PanelLeftOpen size={15} />
          </button>
        )}

        <nav className={cn("space-y-0.5", sidebarCollapsed ? "mt-3" : "mt-5")} aria-label="Primary">
          {navItems.map((item) => renderLink(item, item.icon))}
        </nav>

        <div className="mt-auto border-t border-border pt-2">
          <Menu
            label="Open account menu"
            align="left"
            side="top"
            triggerClassName="h-12 w-full justify-start px-0"
            trigger={
              <span className={cn("flex h-10 w-full items-center", sidebarCollapsed ? "justify-center" : "gap-2.5")}>
                <span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-border-strong bg-surface-raised font-mono text-xs font-medium text-text">
                  {(session.displayName || session.email || "?").charAt(0).toUpperCase()}
                </span>
                {!sidebarCollapsed && <span className="min-w-0 flex-1 text-left"><span className="block truncate text-sm text-text">{session.displayName}</span><span className="block truncate font-mono text-[10px] uppercase tracking-[0.12em] text-text-subtle">{isAdmin ? "Administrator" : session.clientAccountName}</span></span>}
                {!sidebarCollapsed && <ChevronDown className="h-3.5 w-3.5 text-text-subtle" />}
              </span>
            }
            items={[
              { label: "Profile", onSelect: () => router.push("/account") },
              { label: "Log out", tone: "danger", onSelect: () => { void (async () => { await fetch("/api/auth/logout", { method: "POST" }); router.push("/login"); router.refresh(); })(); } }
            ]}
          />
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-20 hidden h-[52px] items-center justify-between border-b border-border bg-surface-hull/95 px-4 backdrop-blur md:flex md:px-5" data-desktop-topbar>
          <Breadcrumbs className="min-w-0" />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent("noderaft:open-search"))}
              className="hidden h-8 items-center gap-2 rounded-control border border-border bg-surface-raised px-2.5 text-xs text-text-muted transition-colors hover:border-border-strong hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus sm:flex"
              aria-label="Open search"
            >
              <Search size={14} />
              <span>Search</span>
              <kbd className="rounded-sm border border-border px-1.5 text-[10px]">⌘K</kbd>
            </button>
            <button
              type="button"
              onClick={() => attentionQuery.refetch()}
              disabled={attentionQuery.isFetching}
              title="Refresh now"
              className={cn(
                "inline-flex items-center gap-1.5 rounded-control px-1.5 py-0.5 font-mono text-[11px] transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-70",
                freshness.state === "unavailable" ? "text-critical-foreground" : freshness.state === "stale" ? "text-warning-foreground" : "text-success-foreground"
              )}
              data-freshness-state={freshness.state}
            >
              <span className={cn("h-1.5 w-1.5 rounded-full", freshness.state === "unavailable" ? "bg-critical" : freshness.state === "stale" ? "bg-warning" : "bg-success", attentionQuery.isFetching && "animate-pulse")} />
              {freshness.label}
            </button>
          </div>
        </header>

        <MobileAppHeader session={session} onAccountOpen={() => setAccountOpen(true)} />

        <main
          className={cn(
            "mx-auto w-full p-gutter",
            contentWidthClass(pathname),
            "max-md:pb-[calc(88px+env(safe-area-inset-bottom))]",
            pinnedActions && "max-md:pb-[calc(168px+env(safe-area-inset-bottom))]"
          )}
        >
          <ViewStateRestoration />
          {children}
        </main>
      </div>

      <MobileBottomNav
        role={session.role}
        attentionCount={isAdmin ? (fleetSummary?.attentionIssues ?? 0) : 0}
      />
      <AccountSheet open={accountOpen} onClose={() => setAccountOpen(false)} session={session} />
      <CommandPalette />
    </div>
  );
}

export { isClientRole };
