"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  BellRing,
  Boxes,
  Container,
  LayoutDashboard,
  ChevronDown,
  Search,
  Server,
  ShieldAlert,
  Users,
  Workflow
} from "lucide-react";
import { cn } from "@/lib/utils";
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
  { key: "nodes", href: "/admin/nodes", label: "Nodes", icon: Server },
  { key: "clients", href: "/admin/clients", label: "Clients", icon: Users },
  { key: "attention", href: "/admin/attention", label: "Attention", icon: ShieldAlert },
  { key: "activity", href: "/admin/activity", label: "Activity", icon: Activity }
];

const ADMIN_SETTINGS: NavItem[] = [
  { key: "users", href: "/admin/settings/users", label: "Users", icon: Users },
  { key: "notifications", href: "/admin/settings/notifications", label: "Notifications", icon: BellRing }
];

const CLIENT_NAV: NavItem[] = [
  { key: "overview", href: "/client", label: "Overview", icon: LayoutDashboard },
  { key: "workloads", href: "/client/workloads", label: "Workloads", icon: Workflow },
  { key: "activity", href: "/client/activity", label: "Activity", icon: Activity }
];

const CLIENT_ADMIN_NAV: NavItem[] = [
  { key: "team", href: "/client/team", label: "Team", icon: Users }
];

export type LayoutVariant = "wide" | "standard" | "full";

/**
 * Resolve a route to one of three intentional layout variants (no arbitrary
 * per-page max widths):
 *  - `wide`   inventory surfaces (Overview, Workloads, Nodes, Clients, Attention, Activity)
 *  - `standard` detail / settings pages
 *  - `full`   logs / editors
 */
export function layoutVariantFor(pathname: string): LayoutVariant {
  if (
    pathname.includes("/deployment/edit") ||
    pathname.startsWith("/admin/containers/") ||
    pathname.startsWith("/client/containers/")
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
    "/client",
    "/client/workloads",
    "/client/containers",
    "/client/activity",
    "/client/team"
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

type FleetSummaryPayload = {
  fleetSummary: {
    attentionIssues: number;
    nodesOnline: number;
    nodesTotal: number;
    workloadsHealthy: number;
    workloadsTotal: number;
    containersRunning: number;
    containersTotal: number;
    degradedWorkloads: number;
    unhealthyContainers: number;
    activeOperations: number;
  };
};

export function DashboardShell({
  children,
  session
}: {
  children: React.ReactNode;
  session: ShellSession;
}): React.JSX.Element {
  return (
    <NavigationProvider>
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
  const isClientAdmin = session.role === "CLIENT_ADMIN";
  const navItems = isAdmin ? ADMIN_NAV : [...CLIENT_NAV, ...(isClientAdmin ? CLIENT_ADMIN_NAV : [])];
  const settingsItems = isAdmin ? ADMIN_SETTINGS : [];
  const overviewHref = isAdmin ? "/admin" : "/client";

  const [accountOpen, setAccountOpen] = useState(false);
  const [now, setNow] = useState<string | null>(null);
  useEffect(() => {
    setNow(new Date().toLocaleString());
  }, []);

  // Attention badge for the mobile bottom tab (admins only). Uses the same
  // authoritative fleet summary as the Overview screen; refreshes slowly.
  const attentionQuery = useQuery({
    queryKey: ["mobile-nav-attention"],
    queryFn: () => apiFetch<FleetSummaryPayload>("/api/admin/overview"),
    refetchInterval: 60_000,
    enabled: isAdmin
  });

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
          "flex items-center gap-2 rounded-control border border-transparent px-3 py-2 text-sm text-text-muted transition-colors hover:bg-surface-raised hover:text-text focus:outline-none focus:ring-2 focus:ring-focus",
          active && "border-selected-border/35 bg-selected text-text"
        )}
        key={item.href}
      >
        <Icon className="h-4 w-4" />
        <span>{item.label}</span>
      </a>
    );
  };

  const pinnedActions = hasPinnedContainerActions(pathname);

  return (
    <div className="min-h-screen md:grid md:grid-cols-[264px_1fr]">
      <aside className="hidden border-b border-border bg-surface-deck p-4 md:block md:sticky md:top-0 md:h-screen md:border-b-0 md:border-r">
        <a
          href={overviewHref}
          aria-label="Noderaft overview"
          onClick={(event) => {
            event.preventDefault();
            goRoot({ key: "overview", href: overviewHref, label: "Overview" });
          }}
          className="inline-flex rounded-control focus:outline-none focus:ring-2 focus:ring-focus"
        >
          <NoderaftLogo priority />
        </a>

        <div className="mt-5 border-y border-border py-3">
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-selected-border/30 bg-surface-raised font-mono text-xs font-medium text-brand"
            >
              {(session.displayName || session.email || "?").charAt(0).toUpperCase()}
            </span>
            <div className="min-w-0">
              <p className="truncate font-medium">{session.displayName}</p>
              <p className="truncate font-mono text-[11px] text-text-muted">{session.email}</p>
            </div>
          </div>
          <p className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-text-subtle">
            {isAdmin ? "Administrator" : session.clientAccountName}
          </p>
        </div>

        <nav className="mt-4 space-y-1" aria-label="Primary">
          {navItems.map((item) => renderLink(item, item.icon))}
        </nav>

        {settingsItems.length > 0 && (
          <>
            <p className="mt-6 px-3 font-mono text-[10px] uppercase tracking-[0.18em] text-text-subtle">Settings</p>
            <nav className="mt-2 space-y-1" aria-label="Settings">
              {settingsItems.map((item) => renderLink(item, item.icon))}
            </nav>
          </>
        )}
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-10 hidden min-h-16 items-center justify-between border-b border-border bg-surface-hull/95 px-4 py-3 backdrop-blur md:flex md:px-6">
          <p className="font-mono text-xs text-text-muted">{now ?? ""}</p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent("noderaft:open-search"))}
              className="hidden items-center gap-2 rounded-control border border-border bg-surface-raised px-3 py-1.5 text-sm text-text-muted transition-colors hover:border-border-strong hover:text-text focus:outline-none focus:ring-2 focus:ring-focus sm:flex"
              aria-label="Open search"
            >
              <Search size={14} />
              <span className="hidden lg:inline">{isAdmin ? "Search nodes, workloads, containers" : "Search workloads, containers"}</span>
              <span className="lg:hidden">Search</span>
              <kbd className="rounded-sm border border-border px-1.5 text-[10px]">⌘K</kbd>
            </button>
            <Menu
              label="Open account menu"
              trigger={<><span className="max-w-36 truncate">{session.displayName}</span><ChevronDown className="ml-1 h-3.5 w-3.5" /></>}
              items={[
                {
                  label: "Account settings",
                  onSelect: () => router.push("/account")
                },
                {
                  label: "Sign out",
                  tone: "danger",
                  onSelect: () => {
                    void (async () => {
                      await fetch("/api/auth/logout", { method: "POST" });
                      router.push("/login");
                      router.refresh();
                    })();
                  }
                }
              ]}
            />
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
        attentionCount={isAdmin ? (attentionQuery.data?.fleetSummary.attentionIssues ?? 0) : 0}
      />
      <AccountSheet open={accountOpen} onClose={() => setAccountOpen(false)} session={session} />
      <CommandPalette />
    </div>
  );
}

export { isClientRole };
