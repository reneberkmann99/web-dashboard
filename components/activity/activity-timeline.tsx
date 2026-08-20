import { Badge } from "@/components/ui/badge";
import { humanizeAction, timeAgo } from "@/lib/format";

export type TimelineEvent = {
  id: string;
  action: string;
  actorEmail: string | null;
  createdAt: string;
  result?: string;
  targetType?: string;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
};

function metadataName(metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata) return null;
  for (const key of ["resourceName", "containerName", "dockerName", "workloadName", "projectName", "nodeName", "clientName", "targetName"]) {
    if (typeof metadata[key] === "string" && metadata[key]) return metadata[key] as string;
  }
  return null;
}

export function activityResourceLabel(event: TimelineEvent, explicitName?: string): string {
  if (explicitName) return explicitName;
  const name = metadataName(event.metadata);
  if (name) return name;
  const labels: Record<string, string> = {
    CONTAINER: "Container",
    PROJECT: "Workload",
    WORKLOAD: "Workload",
    NODE: "Node",
    CLIENT: "Client",
    CLIENT_ACCOUNT: "Client",
    USER: "User",
    DEPLOYMENT: "Deployment",
    SESSION: "Session"
  };
  return labels[event.targetType ?? ""] ?? "Platform";
}

export function ActivityTimeline({
  events,
  resourceName,
  onSelect,
  renderAction,
  emptyText = "No activity recorded.",
  loading = false,
  error = null,
  emptyTitle,
  emptyBody
}: {
  events: TimelineEvent[];
  resourceName?: string;
  onSelect?: (event: TimelineEvent) => void;
  renderAction?: (event: TimelineEvent) => React.ReactNode;
  emptyText?: string;
  loading?: boolean;
  error?: string | null;
  emptyTitle?: string;
  emptyBody?: string;
}): React.JSX.Element {
  if (loading) return <div className="h-40 animate-pulse rounded-panel border border-border bg-surface-deck" />;
  if (error) return <p className="rounded-panel border border-critical/30 bg-critical/5 p-4 text-sm text-critical-foreground">{error}</p>;
  if (events.length === 0) return <div className="rounded-panel border border-border bg-surface-deck p-4"><p className="font-medium">{emptyTitle ?? emptyText}</p>{emptyBody && <p className="mt-1 text-sm text-text-muted">{emptyBody}</p>}</div>;

  return (
    <ol className="divide-y divide-border rounded-panel border border-border bg-surface-deck" aria-label="Operations timeline">
      {events.map((event) => {
        const content = (
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-medium text-text">{humanizeAction(event.action)}</p>
                {event.result === "FAILURE" && <Badge variant="danger">failed</Badge>}
              </div>
              <p className="truncate text-sm text-text-muted">{activityResourceLabel(event, resourceName)}</p>
              <p className="mt-0.5 text-xs text-text-subtle">{event.actorEmail ?? "System"} · {timeAgo(event.createdAt)}</p>
            </div>
            {renderAction && <div className="shrink-0" data-row-action>{renderAction(event)}</div>}
          </div>
        );
        return (
          <li key={event.id}>
            {onSelect ? (
              <button type="button" onClick={() => onSelect(event)} className="w-full px-4 py-3 text-left transition-colors hover:bg-surface-raised/50 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-focus">
                {content}
              </button>
            ) : (
              <div className="px-4 py-3">{content}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
