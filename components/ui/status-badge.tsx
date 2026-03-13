import { Badge } from "@/components/ui/badge";
import type { ContainerStatus } from "@/types/domain";

export function StatusBadge({ status }: { status: ContainerStatus }): React.JSX.Element {
  if (status === "running") {
    return <Badge variant="success">running</Badge>;
  }
  if (status === "stopped") {
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
