import { requireApiCapability } from "@/server/auth/guards";
import { getClientDeploymentOperation, requireClientDeployment } from "@/server/services/client-deployments";
import { fromError, fail, ok } from "@/server/http";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; operationId: string }> }
): Promise<Response> {
  try {
    const session = await requireApiCapability("deployment.view");
    const { id, operationId } = await params;
    await requireClientDeployment(session, id, "deployment.view");
    const operation = await getClientDeploymentOperation(id, operationId);
    if (!operation) return fail("NOT_FOUND", "Operation not found", 404);
    return ok(operation);
  } catch (error) {
    return fromError(error);
  }
}
