import { AlertTriangle, CircleAlert, Inbox, Loader2, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type StateTone = "neutral" | "loading" | "error" | "warning" | "info";

const toneStyles: Record<StateTone, string> = {
  neutral: "border-border bg-surface-raised/45",
  loading: "border-border bg-surface-raised/45",
  error: "border-critical/30 bg-critical/5",
  warning: "border-warning/30 bg-warning/5",
  info: "border-info/30 bg-info/5"
};

const toneIcons: Record<StateTone, LucideIcon> = {
  neutral: Inbox,
  loading: Loader2,
  error: CircleAlert,
  warning: AlertTriangle,
  info: CircleAlert
};

export function StatePanel({
  title,
  description,
  action,
  tone = "neutral",
  compact = false,
  className
}: {
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  tone?: StateTone;
  compact?: boolean;
  className?: string;
}): React.JSX.Element {
  const Icon = toneIcons[tone];
  return (
    <div
      className={cn(
        "rounded-panel border text-center",
        toneStyles[tone],
        compact ? "p-4" : "p-8",
        className
      )}
      role={tone === "error" ? "alert" : tone === "loading" ? "status" : undefined}
      aria-busy={tone === "loading" || undefined}
    >
      <Icon
        className={cn(
          "mx-auto mb-3 h-5 w-5",
          tone === "loading" && "animate-spin text-info-foreground",
          tone === "error" && "text-critical-foreground",
          tone === "warning" && "text-warning-foreground",
          (tone === "neutral" || tone === "info") && "text-text-muted"
        )}
      />
      <p className="font-medium text-text">{title}</p>
      {description && <div className="mx-auto mt-1 max-w-lg text-sm text-text-muted">{description}</div>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function LoadingBlock({ className = "h-40" }: { className?: string }): React.JSX.Element {
  return (
    <div className={cn("animate-pulse rounded-panel border border-border bg-surface-raised/60", className)} aria-busy="true">
      <span className="sr-only">Loading</span>
    </div>
  );
}
