"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  Boxes,
  LayoutDashboard,
  LogOut,
  Server,
  Settings,
  Users,
  Workflow
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { isClientRole } from "@/types/domain";

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
  { href: "/admin/activity", label: "Activity", icon: Activity }
];

const ADMIN_SETTINGS = [
  { href: "/admin/settings/users", label: "Users" },
  { href: "/admin/settings/containers", label: "All containers" }
];

const CLIENT_NAV = [
  { href: "/client", label: "Overview", icon: LayoutDashboard },
  { href: "/client/workloads", label: "Workloads", icon: Workflow },
  { href: "/client/containers", label: "Containers", icon: Boxes }
];

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
  const navItems = isAdmin ? ADMIN_NAV : CLIENT_NAV;
  const settingsItems = isAdmin ? ADMIN_SETTINGS : [];

  return (
    <div className="grid min-h-screen lg:grid-cols-[260px_1fr]">
      <aside className="border-r border-border bg-panel p-4">
        <div className="rounded-lg border border-border bg-panelAlt p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-accent">HostPanel</p>
          <p className="mt-3 font-medium">{session.displayName}</p>
          <p className="text-xs text-muted">{session.email}</p>
          <p className="mt-1 text-xs text-muted">
            {isAdmin ? "Administrator" : session.clientAccountName}
          </p>
        </div>

        <nav className="mt-4 space-y-1" aria-label="Primary">
          {navItems.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            const Icon = item.icon;
            return (
              <Link
                className={cn(
                  "flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted transition hover:bg-panelAlt hover:text-text focus:outline-none focus:ring-2 focus:ring-accent",
                  active && "bg-panelAlt text-text"
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
            <p className="mt-6 px-3 text-xs uppercase tracking-wide text-muted">Settings</p>
            <nav className="mt-2 space-y-1" aria-label="Settings">
              {settingsItems.map((item) => {
                const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                return (
                  <Link
                    className={cn(
                      "flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted transition hover:bg-panelAlt hover:text-text focus:outline-none focus:ring-2 focus:ring-accent",
                      active && "bg-panelAlt text-text"
                    )}
                    href={item.href}
                    key={item.href}
                  >
                    <Settings className="h-4 w-4" />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </nav>
          </>
        )}
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-background/95 px-4 py-3 backdrop-blur md:px-6 md:py-4">
          <p className="hidden text-sm text-muted sm:block">{new Date().toLocaleString()}</p>
          <p className="text-sm text-muted sm:hidden">HostPanel</p>
          <Button
            size="sm"
            variant="secondary"
            onClick={async () => {
              await fetch("/api/auth/logout", { method: "POST" });
              router.push("/login");
              router.refresh();
            }}
          >
            <LogOut className="mr-2 h-4 w-4" />
            Logout
          </Button>
        </header>

        <main className="mx-auto w-full max-w-7xl p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}

export { isClientRole };
