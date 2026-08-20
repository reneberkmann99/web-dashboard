import type { Metadata } from "next";
import { requirePageSession } from "@/server/auth/guards";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { PlatformProviders } from "@/components/providers/platform-providers";

export const metadata: Metadata = {
  robots: { index: false, follow: false }
};

export default async function DashboardLayout({
  children
}: {
  children: React.ReactNode;
}): Promise<React.JSX.Element> {
  const session = await requirePageSession();

  return (
    <PlatformProviders>
      <DashboardShell
        session={{
          email: session.email,
          displayName: session.displayName,
          role: session.role,
          clientAccountName: session.clientAccountName
        }}
      >
        {children}
      </DashboardShell>
    </PlatformProviders>
  );
}
