import { requirePageSession } from "@/server/auth/guards";
import { DashboardShell } from "@/components/layout/dashboard-shell";

export default async function DashboardLayout({
  children
}: {
  children: React.ReactNode;
}): Promise<React.JSX.Element> {
  const session = await requirePageSession();

  return (
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
  );
}
