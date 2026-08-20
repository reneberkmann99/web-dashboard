"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  BellRing,
  Boxes,
  LayoutDashboard,
  ChevronDown,
  Search,
  Server,
  Settings,
  ShieldAlert,
  Users,
  Workflow
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { isClientRole } from "@/types/domain";
import { CommandPalette } from "@/components/search/command-palette";
import { NoderaftLogo } from "@/components/brand/noderaft-logo";
import { Menu } from "@/components/ui/menu";

type ShellSession = {
  displayName: string;
  email: string;
  role: string;
  clientAccountName: string | null;
};

const ADMIN_NAV = [
  { href: "/admin", label: "Overview", icon: LayoutDashboard },
  { href: "/admin/workloads", label: "Workloads", icon: Boxes },
  { href: "/admin/nodes", label: "Nodes", icon: Server },
  { href: "/admin/clients", label: "Clients", icon: Users },
  { href: "/admin/attention", label: "Attention", icon: ShieldAlert },
  { href: "/admin/activity", label: "Activity", icon: Activity }
];

const ADMIN_SETTINGS = [
  { href: "/admin/settings/users", label: "Users", icon: Settings },
  { href: "/admin/settings/containers", label: "All containers", icon: Settings },
  { href: "/admin/settings/notifications", label: "Notifications", icon: BellRing }
];

const CLIENT_NAV = [
  { href: "/client", label: "Overview", icon: LayoutDashboard },
  { href: "/client/workloads", label: "Workloads", icon: Workflow },
  { href: "/client/activity", label: "Activity", icon: Activity }
];

const CLIENT_ADMIN_NAV = [
  { href: "/client/team", label: "Team", icon: Users }
];

function isActiveNavPath(pathname: string, href: string): boolean {
  if (pathname === href) return true;
  // The role landing routes (/admin and /client) are exact matches; without
  // this guard they would also match every descendant route.
  if (href === "/admin" || href === "/client") return false;
  return pathname.startsWith(`${href}/`);
}

export function DashboardShell({
  children,
  session
}: {
  children: React.ReactNode;
  session: ShellSession;
}): React.JSX.Element {
  const pathname = usePathname();
  const router = useRouter();
  const isAdmin = session.role === "ADMIN";
  const isClientAdmin = session.role === "CLIENT_ADMIN";
  const navItems = isAdmin
    ? ADMIN_NAV
    : [...CLIENT_NAV, ...(isClientAdmin ? CLIENT_ADMIN_NAV : [])];
  const settingsItems = isAdmin ? ADMIN_SETTINGS : [];

  // Rendered only after mount so server (UTC) and browser (local timezone)
  // never disagree during hydration (React #418).
  const [now, setNow] = useState<string | null>(null);
  useEffect(() => {
    setNow(new Date().toLocaleString());
  }, []);

  return (
    <div className="grid min-h-screen lg:grid-cols-[264px_1fr]">
      <aside className="border-b border-border bg-surface-deck p-4 lg:sticky lg:top-0 lg:h-screen lg:border-b-0 lg:border-r">
        <Link href={isAdmin ? "/admin" : "/client"} aria-label="Noderaft overview" className="inline-flex rounded-control focus:outline-none focus:ring-2 focus:ring-focus">
          <NoderaftLogo priority />
        </Link>

        <div className="mt-5 border-y border-border py-3">
          <p className="font-medium">{session.displayName}</p>
          <p className="truncate font-mono text-[11px] text-text-muted">{session.email}</p>
          <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.16em] text-text-subtle">
            {isAdmin ? "Administrator" : session.clientAccountName}
          </p>
        </div>

        <nav className="mt-4 space-y-1" aria-label="Primary">
          {navItems.map((item) => {
            const active = isActiveNavPath(pathname, item.href);
            const Icon = item.icon;
            return (
              <Link
                className={cn(
                  "flex items-center gap-2 rounded-control border border-transparent px-3 py-2 text-sm text-text-muted transition-colors hover:bg-surface-raised hover:text-text focus:outline-none focus:ring-2 focus:ring-focus",
                  active && "border-selected-border/35 bg-selected text-text"
                )}
                href={item.href}
                key={item.href}
              >
                <Icon className="h-4 w-4" />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        {settingsItems.length > 0 && (
          <>
            <p className="mt-6 px-3 font-mono text-[10px] uppercase tracking-[0.18em] text-text-subtle">Settings</p>
            <nav className="mt-2 space-y-1" aria-label="Settings">
              {settingsItems.map((item) => {
                const active = isActiveNavPath(pathname, item.href);
                const Icon = item.icon;
                return (
                  <Link
                    className={cn(
                      "flex items-center gap-2 rounded-control border border-transparent px-3 py-2 text-sm text-text-muted transition-colors hover:bg-surface-raised hover:text-text focus:outline-none focus:ring-2 focus:ring-focus",
                      active && "border-selected-border/35 bg-selected text-text"
                    )}
                    href={item.href}
                    key={item.href}
                  >
                    <Icon className="h-4 w-4" />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
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

        <main className="mx-auto w-full max-w-7xl p-gutter">{children}</main>
      </div>
      <CommandPalette />
    </div>
  );
}

export { isClientRole };
