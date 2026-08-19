import { requireApiRole } from "@/server/auth/guards";
import { getContainerDirect, getContainerLogsDirect } from "@/server/services/containers";
import { requestOperation, OperationConflictError } from "@/server/services/operations";
import { getAdminWorkloadDeploymentStatus } from "@/server/services/deployments";
import { containerActionSchema } from "@/server/validation/admin";
import { fail, fromError, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,127}$/;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ nodeId: string; dockerId: string }> }
): Promise<Response> {
  try {
    await requireApiRole("ADMIN");
    const { nodeId, dockerId } = await params;
    if (!ID_RE.test(dockerId)) {
      return fail("VALIDATION_ERROR", "Invalid container id", 400);
    }
    const url = new URL(request.url);
    if (url.searchParams.get("logs") === "1") {
      const tail = Math.min(Number(url.searchParams.get("tail") ?? "200"), 500);
      const result = await getContainerLogsDirect(nodeId, dockerId, tail);
      return ok(result);
    }
    const { container, nodeOnline } = await getContainerDirect(nodeId, dockerId);
    if (!container) {
      return fail("NOT_FOUND", "Container not found", 404);
    }
    // Managed ownership context (workload/revision/release) for the UI banner.
    const managedDeployment = container.projectId
      ? await getAdminWorkloadDeploymentStatus(container.projectId)
      : null;
    return ok({ container, nodeOnline, managedDeployment });
  } catch (error) {
    return fromError(error);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ nodeId: string; dockerId: string }> }
): Promise<Response> {
  try {
    const session = await requireApiRole("ADMIN");
    const { nodeId, dockerId } = await params;
    if (!ID_RE.test(dockerId)) {
      return fail("VALIDATION_ERROR", "Invalid container id", 400);
    }
    const body = containerActionSchema.parse(await request.json());
    const sourceIp = getSourceIpFromRequest(request);

    try {
      const operationId = await requestOperation({
        type: `CONTAINER_${body.action.toUpperCase()}` as "CONTAINER_START" | "CONTAINER_STOP" | "CONTAINER_RESTART",
        actor: session,
        clientAccountId: null,
        nodeId,
        dockerContainerId: dockerId,
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
