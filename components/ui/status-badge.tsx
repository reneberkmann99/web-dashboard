import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ContainerStatus } from "@/types/domain";

/**
 * Container runtime-state badge (§5 status vocabulary).
 *
 * Runtime state and health/attention are separate concepts:
 *  - `running`      → quiet success dot (running is the declared norm, not a
 *                     celebration; stays visually calm)
 *  - `stopped` + expectedStopped → quiet neutral "stopped intentionally"
 *  - `stopped` unexpected        → danger (someone must act)
 *  - `restarting`   → warning
 *  - `unhealthy`    → warning
 *  - `unknown`      → neutral, never 0%/green
 *
 * `health` merges the Docker healthcheck into this same chip as a second dot
 * rather than a separate table column that's blank on every row without a
 * healthcheck (design review round 2, §2).
 */
export function StatusBadge({
  status,
  expectedStopped,
  health
}: {
  status: ContainerStatus;
  expectedStopped?: boolean;
  health?: string | null;
}): React.JSX.Element {
  const healthDot = health ? (
    <span
      aria-label={`Healthcheck: ${health}`}
      title={`Healthcheck: ${health}`}
      className={cn(
        "ml-1.5 inline-block h-1.5 w-1.5 rounded-full",
        health === "healthy" ? "bg-success" : health === "unhealthy" ? "bg-critical" : "bg-warning"
      )}
    />
  ) : null;

  if (status === "running") {
    return <Badge variant="success">running{healthDot}</Badge>;
  }
  if (status === "stopped") {
    if (expectedStopped) {
      return <Badge variant="outline">stopped intentionally{healthDot}</Badge>;
    }
    return <Badge variant="danger">stopped{healthDot}</Badge>;
  }
  if (status === "restarting") {
    return <Badge variant="warning">restarting{healthDot}</Badge>;
  }
  if (status === "unhealthy") {
    return <Badge variant="warning">unhealthy{healthDot}</Badge>;
  }
  return <Badge>unknown{healthDot}</Badge>;
}
