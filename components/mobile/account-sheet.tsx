"use client";

import { useRouter } from "next/navigation";
import { Bell, Container, LogOut, Settings, UserCog, UserRound, Users } from "lucide-react";
import { MobileSheet } from "@/components/mobile/mobile-sheet";
import { useNavigation } from "@/components/navigation/navigation-context";
import { MOBILE_SHEET_DESTINATIONS, type RootDef } from "@/lib/navigation";

/**
 * Account sheet (design §07) — where secondary/admin destinations live on
 * mobile: Containers, Organizations, All Users, Alerting, Account
 * settings, Log out. Bottom sheet, safe-area aware, closes on selection,
 * clear account identity. Never a sidebar clone.
 */
export function AccountSheet({
  open,
  onClose,
  session
}: {
  open: boolean;
  onClose: () => void;
  session: { displayName: string; email: string; role: string; clientAccountName: string | null };
}): React.JSX.Element {
  const router = useRouter();
  const { rootKey, rootHref, stack, goRoot, setMobileReturn } = useNavigation();
  const isAdmin = session.role === "ADMIN";
  const isOrganizationAdmin = session.role === "CLIENT_ADMIN";

  const currentRoot: RootDef = {
    key: rootKey,
    href: rootHref,
    label: stack[0]?.label ?? "Overview"
  };

  const navigate = (def: RootDef): void => {
    // Remember where the sheet was opened so the header back chevron can
    // return to that root after visiting a sheet destination. Must run AFTER
    // goRoot (which clears any pending return target).
    goRoot(def);
    setMobileReturn(currentRoot);
    onClose();
  };

  const signOut = (): void => {
    void (async () => {
      await fetch("/api/auth/logout", { method: "POST" });
      router.push("/login");
      router.refresh();
    })();
  };

  const row = (
    label: string,
    icon: React.ReactNode,
    onClick: () => void,
    opts: { danger?: boolean; count?: string; testId?: string } = {}
  ): React.JSX.Element => (
    <button
      type="button"
      onClick={onClick}
      data-testid={opts.testId}
      className={
        "flex h-[50px] w-full items-center gap-[13px] rounded-[10px] px-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus " +
        (opts.danger ? "text-critical-foreground" : "text-text hover:bg-surface-raised")
      }
    >
      <span className={opts.danger ? "text-critical-foreground" : "text-text-muted"}>{icon}</span>
      <span className="text-[15px]">{label}</span>
      {opts.count && <span className="ml-auto font-mono text-xs text-text-subtle">{opts.count}</span>}
    </button>
  );

  return (
    <div className="md:hidden">
      <MobileSheet open={open} onClose={onClose} title="Account">
        <div className="flex items-center gap-[13px] border-b border-border pb-4">
          <span className="grid h-11 w-11 flex-none place-items-center rounded-full border border-border bg-surface-raised font-mono text-[17px] text-brand">
            {(session.displayName || session.email || "?").charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0">
            <p className="truncate text-base font-medium">{session.displayName}</p>
            <p className="truncate font-mono text-[11.5px] text-text-muted">
              {session.email} · {session.role === "ADMIN" ? "Administrator" : session.clientAccountName}
            </p>
          </div>
        </div>

        <div className="py-1.5">
          {isAdmin &&
            row(
              "Containers",
              <Container size={19} />,
              () => navigate(MOBILE_SHEET_DESTINATIONS.containers),
              { testId: "account-sheet-containers" }
            )}
          {isAdmin &&
            row(
              "Organizations",
              <Users size={19} />,
              () => navigate(MOBILE_SHEET_DESTINATIONS.organizations),
              { testId: "account-sheet-organizations" }
            )}
          {isAdmin &&
            row(
              "All Users",
              <UserCog size={19} />,
              () => navigate(MOBILE_SHEET_DESTINATIONS.users),
              { testId: "account-sheet-users" }
            )}
          {isAdmin &&
            row(
              "Alerting",
              <Bell size={19} />,
              () => navigate(MOBILE_SHEET_DESTINATIONS.alerting),
              { testId: "account-sheet-alerting" }
            )}
          {isAdmin && row("Platform Settings", <Settings size={19} />, () => navigate(MOBILE_SHEET_DESTINATIONS.platformSettings), { testId: "account-sheet-platform-settings" })}
          {isOrganizationAdmin && row("Members", <Users size={19} />, () => navigate(MOBILE_SHEET_DESTINATIONS.members), { testId: "account-sheet-members" })}
          {isOrganizationAdmin && row("Settings", <Settings size={19} />, () => navigate(MOBILE_SHEET_DESTINATIONS.settings), { testId: "account-sheet-organization-settings" })}
          {row(
            "Account settings",
            <UserRound size={19} />,
            () => {
              onClose();
              router.push("/account");
            },
            { testId: "account-sheet-settings" }
          )}
          {row(
            "Log out",
            <LogOut size={19} />,
            signOut,
            { danger: true, testId: "account-sheet-logout" }
          )}
        </div>

        <p className="pt-3 font-mono text-[10.5px] text-text-subtle">noderaft-panel 0.1.0</p>
      </MobileSheet>
    </div>
  );
}
