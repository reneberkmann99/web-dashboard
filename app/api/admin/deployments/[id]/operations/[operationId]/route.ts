import { requireApiRole } from "@/server/auth/guards";
import { getDeploymentOperationForSession } from "@/server/services/deployment-executor";
import { cuidParamSchema } from "@/server/validation/admin";
import { fromError, fail, ok } from "@/server/http";

/** Get a single deployment operation (ADMIN). */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; operationId: string }> }
): Promise<Response> {
  try {
    const session = await requireApiRole("ADMIN");
    const { id, operationId } = await params;
    void cuidParamSchema.parse(id);
    const opId = cuidParamSchema.parse(operationId);

    const operation = await getDeploymentOperationForSession(session, opId);
    if (!operation) return fail("NOT_FOUND", "Operation not found", 404);
    return ok(operation);
  } catch (error) {
    return fromError(error);
  }
}
