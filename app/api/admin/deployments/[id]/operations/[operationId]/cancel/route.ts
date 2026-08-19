import { requireApiRole } from "@/server/auth/guards";
import { requestCancellation } from "@/server/services/deployment-executor";
import { cuidParamSchema } from "@/server/validation/admin";
import { fromError, fail, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";

/**
 * Request cancellation of a deployment operation. Cancellation stops future
 * stages, best-effort aborts, then VERIFY + RECONCILE to record actual runtime.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; operationId: string }> }
): Promise<Response> {
  try {
    const session = await requireApiRole("ADMIN");
    const sourceIp = getSourceIpFromRequest(request);
    const { id, operationId } = await params;
    void cuidParamSchema.parse(id);
    const opId = cuidParamSchema.parse(operationId);

    const result = await requestCancellation(opId, session, sourceIp);
    switch (result.status) {
      case "not_found":
        return fail("NOT_FOUND", "Operation not found", 404);
      case "not_cancellable":
        return fail("NOT_CANCELLABLE", "Operation is not in a cancellable state", 409);
      case "cancelled":
        return ok({ cancelled: true }, 202);
    }
  } catch (error) {
    return fromError(error);
  }
}
