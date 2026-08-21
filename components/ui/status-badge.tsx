import { Badge } from "@/components/ui/badge";
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
 */
export function StatusBadge({
  status,
  expectedStopped
}: {
  status: ContainerStatus;
  expectedStopped?: boolean;
}): React.JSX.Element {
  if (status === "running") {
    return <Badge variant="success">running</Badge>;
  }
  if (status === "stopped") {
    if (expectedStopped) {
      return <Badge variant="outline">stopped intentionally</Badge>;
    }
    return <Badge variant="danger">stopped</Badge>;
  }
  if (status === "restarting") {
    return <Badge variant="warning">restarting</Badge>;
  }
  if (status === "unhealthy") {
    return <Badge variant="warning">unhealthy</Badge>;
  }
  return <Badge>unknown</Badge>;
}
