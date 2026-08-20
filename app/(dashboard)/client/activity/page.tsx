"use client";

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetcher";
import { PageHeader } from "@/components/ui/page-header";
import { ActivityTimeline } from "@/components/activity/activity-timeline";

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

      <ActivityTimeline
        events={query.data?.events ?? []}
        loading={query.isLoading}
        error={query.isError ? "Failed to load activity" : null}
        emptyTitle="No activity yet"
        emptyBody="Actions on your workloads and containers will appear here."
      />
    </div>
  );
}
