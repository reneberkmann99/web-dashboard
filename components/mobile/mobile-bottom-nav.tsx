"use client";

import { Activity, Boxes, LayoutDashboard, Server, ShieldAlert, Users, Workflow } from "lucide-react";
import { useNavigation } from "@/components/navigation/navigation-context";
import { cn } from "@/lib/utils";
import type { NavRootKey } from "@/lib/navigation";

/**
 * Mobile bottom tab bar (design §02) — exactly five primary destinations for
 * admins (Overview · Workloads · Nodes · Attention · Activity); clients get
 * their existing roots (Overview · Workloads · Activity [+ Team for
 * CLIENT_ADMIN]). Containers/Clients/Users/Notifications deliberately never
 * appear here — they live in the account sheet.
 *
 * Fixed to the viewport bottom, safe-area aware, 44px+ touch targets, icon +
 * short label, no horizontal scrolling. The current navigation ROOT is
 * highlighted (rootKey, not URL) so drilling into a container keeps its
 * parent tab highlighted until the user explicitly picks another tab.
 */
export function MobileBottomNav({
  role,
  attentionCount
}: {
  role: string;
  attentionCount?: number;
}): React.JSX.Element {
  const { rootKey, goRoot } = useNavigation();

  const isAdmin = role === "ADMIN";
  const isClientAdmin = role === "CLIENT_ADMIN";
  const items: Array<{ key: NavRootKey; href: string; label: string; icon: React.ComponentType<{ size?: number; className?: string }> }> = isAdmin
    ? [
        { key: "overview", href: "/admin", label: "Overview", icon: LayoutDashboard },
        { key: "workloads", href: "/admin/workloads", label: "Workloads", icon: Boxes },
        { key: "nodes", href: "/admin/nodes", label: "Nodes", icon: Server },
        { key: "attention", href: "/admin/attention", label: "Attention", icon: ShieldAlert },
        { key: "activity", href: "/admin/activity", label: "Activity", icon: Activity }
      ]
    : [
        { key: "overview", href: "/client", label: "Overview", icon: LayoutDashboard },
        { key: "workloads", href: "/client/workloads", label: "Workloads", icon: Workflow },
        ...(isClientAdmin ? [{ key: "team" as const, href: "/client/team", label: "Team", icon: Users }] : []),
        { key: "activity", href: "/client/activity", label: "Activity", icon: Activity }
      ];

  return (
    <nav
      aria-label="Primary"
      data-mobile-bottom-nav
      className="fixed inset-x-0 bottom-0 z-40 grid border-t border-border bg-surface-deck/98 backdrop-blur md:hidden"
      style={{ gridTemplateColumns: `repeat(${items.length}, 1fr)`, padding: "8px 8px calc(6px + env(safe-area-inset-bottom))" }}
    >
      {items.map((item) => {
        const active = rootKey === item.key;
        const Icon = item.icon;
        return (
          <a
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            onClick={(event) => {
              event.preventDefault();
              goRoot({ key: item.key, href: item.href, label: item.label });
            }}
            className={cn(
              "relative flex flex-col items-center gap-[5px] rounded-[10px] py-[7px] transition-colors focus:outline-none focus:ring-2 focus:ring-focus",
              active ? "text-brand" : "text-text-muted hover:text-text"
            )}
          >
            <span className="relative grid place-items-center">
              <Icon size={21} />
              {item.key === "attention" && (attentionCount ?? 0) > 0 && (
                <span
                  className="absolute -right-[13px] -top-[5px] grid min-w-[15px] place-items-center rounded-full bg-warning px-1 font-mono text-[9px] leading-[15px] text-text-inverse"
                  aria-label={`${attentionCount} attention items`}
                >
                  {attentionCount}
                </span>
              )}
            </span>
            <span className="text-[10px] leading-none">{item.label}</span>
          </a>
        );
      })}
    </nav>
  );
}
