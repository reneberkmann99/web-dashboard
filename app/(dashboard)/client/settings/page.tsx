"use client";

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetcher";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type MePayload = {
  user: { email: string; role: string; clientAccountId: string | null; clientAccountName: string | null };
};

export default function ClientSettingsPage(): React.JSX.Element {
  const query = useQuery({ queryKey: ["organization-settings"], queryFn: () => apiFetch<MePayload>("/api/auth/me") });
  const organization = query.data?.user;

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Organization" title="Settings" description="Review your organization identity and access configuration." />
      <Card>
        <CardHeader><CardTitle>Organization details</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          {query.isLoading ? <div className="h-8 animate-pulse rounded bg-panelAlt" /> : query.isError || !organization ? <p className="text-critical-foreground">Failed to load organization settings.</p> : (
            <>
              <div className="flex justify-between gap-4 border-b border-border pb-3"><span className="text-muted">Name</span><span>{organization.clientAccountName ?? "—"}</span></div>
              <div className="flex justify-between gap-4 border-b border-border pb-3"><span className="text-muted">Organization ID</span><span className="font-mono text-xs">{organization.clientAccountId ?? "—"}</span></div>
              <div className="flex justify-between gap-4"><span className="text-muted">Your role</span><span>{organization.role.replaceAll("CLIENT_", "").replaceAll("_", " ").toLowerCase()}</span></div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
