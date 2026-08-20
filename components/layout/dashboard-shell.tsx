"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
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
import { CommandPalette } from "@/components/search/command-palette";
import { NoderaftLogo } from "@/components/brand/noderaft-logo";
import { Menu } from "@/components/ui/menu";
import { ViewStateRestoration } from "@/components/navigation/view-state";
import { NavigationProvider, useNavigation } from "@/components/navigation/navigation-context";
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

  const [now, setNow] = useState<string | null>(null);
  useEffect(() => {
    setNow(new Date().toLocaleString());
  }, []);

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

  return (
    <div className="grid min-h-screen lg:grid-cols-[264px_1fr]">
      <aside className="border-b border-border bg-surface-deck p-4 lg:sticky lg:top-0 lg:h-screen lg:border-b-0 lg:border-r">
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
          <p className="font-medium">{session.displayName}</p>
          <p className="truncate font-mono text-[11px] text-text-muted">{session.email}</p>
          <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.16em] text-text-subtle">
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
        <header className="sticky top-0 z-10 flex min-h-16 items-center justify-between border-b border-border bg-surface-hull/95 px-4 py-3 backdrop-blur md:px-6">
          <p className="hidden font-mono text-xs text-text-muted sm:block">{now ?? ""}</p>
          <NoderaftLogo compact className="sm:hidden" />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent("noderaft:open-search"))}
              className="hidden items-center gap-2 rounded-control border border-border bg-surface-raised px-3 py-1.5 text-sm text-text-muted transition-colors hover:border-border-strong hover:text-text focus:outline-none focus:ring-2 focus:ring-focus sm:flex"
              aria-label="Open search"
            >
              <Search size={14} />
              <span>Search</span>
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

        <main className={cn("mx-auto w-full p-gutter", contentWidthClass(pathname))}>
          <ViewStateRestoration />
          {children}
        </main>
      </div>
      <CommandPalette />
    </div>
  );
}

export { isClientRole };
