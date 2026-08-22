"use client";

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetcher";
import { AttentionBadge } from "@/components/ui/attention-badge";
import { PageHeader } from "@/components/ui/page-header";
import type { AttentionItem } from "@/types/domain";

type OrganizationAttentionPayload = { attention: AttentionItem[] };

/** Organization-scoped operational attention; the API never returns fleet/node issues here. */
export default function ClientAttentionPage(): React.JSX.Element {
  const query = useQuery({
    queryKey: ["client-attention"],
    queryFn: () => apiFetch<OrganizationAttentionPayload>("/api/client/overview"),
    refetchInterval: 15000
  });
  const attention = query.data?.attention ?? [];

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Operations" title="Attention" description="Operational conditions affecting your organization&apos;s workloads." />
      {query.isLoading ? (
        <div className="h-32 animate-pulse rounded-lg bg-panelAlt" />
      ) : query.isError ? (
        <p className="text-sm text-critical-foreground">Failed to load attention.</p>
      ) : attention.length === 0 ? (
        <div className="rounded-lg border border-border bg-panel p-6 text-sm">
          <p className="font-medium">Nothing needs attention</p>
          <p className="mt-1 text-muted">Your organization&apos;s workloads have no active operational conditions.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {attention.map((item) => (
            <a key={item.id} href={item.href ?? "#"} className="flex items-start justify-between gap-3 rounded-lg border border-border bg-panel p-4 hover:bg-panelAlt">
              <div>
                <p className="font-medium">{item.title}</p>
                <p className="mt-1 text-sm text-muted">{item.detail}</p>
              </div>
              <AttentionBadge severity={item.severity} />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
