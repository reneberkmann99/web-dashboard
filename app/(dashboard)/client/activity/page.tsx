"use client";

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetcher";
import { PageHeader } from "@/components/ui/page-header";
import { ActivityTimeline } from "@/components/activity/activity-timeline";
import { MobileActivityList } from "@/components/mobile/mobile-activity-list";

type AuditEvent = {
  id: string;
  createdAt: string;
  actorEmail: string | null;
  actorRole: string | null;
  action: string;
  humanized: string;
  targetType: string;
  targetId: string | null;
  result: string;
};

type ActivityPayload = { events: AuditEvent[]; total: number };

export default function ClientActivityPage(): React.JSX.Element {
  const query = useQuery({
    queryKey: ["client-activity"],
    queryFn: () => apiFetch<ActivityPayload>("/api/client/activity?limit=200"),
    refetchInterval: 15000
  });

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Audit trail" title="Activity" description="Recent actions on the services assigned to you." />

      <div className="max-md:hidden">
      <ActivityTimeline
        events={query.data?.events ?? []}
        loading={query.isLoading}
        error={query.isError ? "Failed to load activity" : null}
        emptyTitle="No activity yet"
        emptyBody="Actions on your workloads and containers will appear here."
      />
      </div>
      <div className="md:hidden">
        {query.isLoading ? (
          <div className="h-40 animate-pulse rounded-panel border border-border bg-surface-deck" />
        ) : query.isError ? (
          <p className="rounded-panel border border-critical/30 bg-critical/5 p-4 text-sm text-critical-foreground">Failed to load activity.</p>
        ) : (
          <MobileActivityList events={query.data?.events ?? []} />
        )}
      </div>
    </div>
  );
}
