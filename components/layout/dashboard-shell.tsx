"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LayoutDashboard, Boxes, Users, Server, Link2, ScrollText, LogOut } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type ShellSession = {
  displayName: string;
  email: string;
  role: "ADMIN" | "CLIENT";
  clientAccountName: string | null;
};

export function DashboardShell({
  children,
  session
}: {
  children: React.ReactNode;
  session: ShellSession;
}): React.JSX.Element {
  const pathname = usePathname();
  const router = useRouter();

  const navItems =
    session.role === "ADMIN"
        ? [
          { href: "/admin", label: "Overview", icon: LayoutDashboard },
          { href: "/admin/containers", label: "Containers", icon: Boxes },
          { href: "/admin/clients", label: "Clients", icon: Users },
          { href: "/admin/users", label: "Users", icon: Users },
          { href: "/admin/nodes", label: "Nodes", icon: Server },
          { href: "/admin/assignments", label: "Assignments", icon: Link2 },
          { href: "/admin/audit-logs", label: "Audit logs", icon: ScrollText }
        ]
      : [
          { href: "/client", label: "Overview", icon: LayoutDashboard },
          { href: "/client/containers", label: "Containers", icon: Boxes }
        ];

  return (
    <div className="grid min-h-screen lg:grid-cols-[260px_1fr]">
      <aside className="border-r border-border bg-panel p-4">
        <div className="rounded-lg border border-border bg-panelAlt p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-accent">HostPanel</p>
          <p className="mt-3 font-medium">{session.displayName}</p>
          <p className="text-xs text-muted">{session.email}</p>
          <p className="mt-1 text-xs text-muted">{session.role === "ADMIN" ? "Administrator" : session.clientAccountName}</p>
        </div>

        <nav className="mt-4 space-y-1">
          {navItems.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            const Icon = item.icon;
            return (
              <Link
                className={cn(
                  "flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted transition hover:bg-panelAlt hover:text-text",
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
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-background/95 px-6 py-4 backdrop-blur">
          <p className="text-sm text-muted">{new Date().toLocaleString()}</p>
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

        <main className="mx-auto w-full max-w-7xl p-6">{children}</main>
      </div>
    </div>
  );
}
