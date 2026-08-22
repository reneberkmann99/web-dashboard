import { z } from "zod";
import { requireApiRole } from "@/server/auth/guards";
import { getContainerDirect } from "@/server/services/containers";
import { requestOperation, OperationConflictError } from "@/server/services/operations";
import { getSourceIpFromRequest } from "@/server/request";
import { fail, fromError, ok } from "@/server/http";

const bodySchema = z.object({
  action: z.enum(["start", "stop", "restart"]),
  targets: z.array(z.object({ nodeId: z.string().min(1).max(128), containerId: z.string().min(2).max(128) })).min(1).max(100)
});

/**
 * Queue a state-compatible action for a bounded set of containers. Every
 * target is re-read and authorized server-side; incompatible/missing targets
 * are reported instead of silently mixing actions.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const session = await requireApiRole("ADMIN");
    const body = bodySchema.parse(await request.json());
    const sourceIp = getSourceIpFromRequest(request);
    const failures: Array<{ containerId: string; reason: string }> = [];
    let queued = 0;

    for (const target of body.targets) {
      const { container, nodeOnline } = await getContainerDirect(target.nodeId, target.containerId);
      if (!container) {
        failures.push({ containerId: target.containerId, reason: "Container not found" });
        continue;
      }
      if (!nodeOnline) {
        failures.push({ containerId: target.containerId, reason: "Node unavailable" });
        continue;
      }
      const compatible = body.action === "start"
        ? container.status === "stopped"
        : body.action === "restart"
          ? container.status === "running"
          : container.status === "running" || container.status === "restarting";
      if (!compatible) {
        failures.push({ containerId: target.containerId, reason: `${body.action} is incompatible with ${container.status}` });
        continue;
      }
      try {
        await requestOperation({
          type: `CONTAINER_${body.action.toUpperCase()}` as "CONTAINER_START" | "CONTAINER_STOP" | "CONTAINER_RESTART",
          actor: session,
          clientAccountId: null,
          nodeId: target.nodeId,
          dockerContainerId: target.containerId,
          sourceIp
        });
        queued += 1;
      } catch (error) {
        failures.push({
          containerId: target.containerId,
          reason: error instanceof OperationConflictError ? "An operation is already in progress" : error instanceof Error ? error.message : "Queue failed"
        });
      }
    }

    if (queued === 0 && failures.length > 0) return fail("NO_COMPATIBLE_TARGETS", "No compatible container actions were queued", 409, { failures });
    return ok({ queued, failures }, 202);
  } catch (error) {
    return fromError(error);
  }
}
