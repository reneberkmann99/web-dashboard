import { requireApiRole, requireCapability } from "@/server/auth/guards";
import type { Capability } from "@/server/auth/policy";
import { resolveActionTarget } from "@/server/services/containers";
import { requestOperation, OperationConflictError } from "@/server/services/operations";
import { fail, fromError, ok } from "@/server/http";
import { containerActionSchema, cuidParamSchema } from "@/server/validation/admin";
import { getSourceIpFromRequest } from "@/server/request";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const id = cuidParamSchema.parse((await params).id);
    const session = await requireApiRole("CLIENT");

    const body = containerActionSchema.parse(await request.json());
    const sourceIp = getSourceIpFromRequest(request);

    // Capability gate BEFORE grant resolution: a grant may permit an action on
    // a container, but the caller's ROLE must also permit it. CLIENT_VIEWER has
    // no runtime capabilities and is refused here even for granted containers.
    requireCapability(session, `container.${body.action}` as Capability);

    const target = await resolveActionTarget(session, id, body.action);
    if (!target) {
      return fail("ACTION_DENIED", "Action is not allowed for this container", 403);
    }

    try {
      const operationId = await requestOperation({
        type: `CONTAINER_${body.action.toUpperCase()}` as "CONTAINER_START" | "CONTAINER_STOP" | "CONTAINER_RESTART",
        actor: session,
        clientAccountId: session.clientAccountId,
        nodeId: target.nodeId,
        dockerContainerId: target.dockerContainerId,
        targetAssignmentId: id,
        sourceIp
      });
      return ok({ operationId }, 202);
    } catch (error) {
      if (error instanceof OperationConflictError) {
        return fail("OPERATION_CONFLICT", "An operation is already in progress for this container", 409, {
          operationId: error.existingOperationId
        });
      }
      throw error;
    }
  } catch (error) {
    return fromError(error);
  }
}
