import { requireApiRole } from "@/server/auth/guards";
import { getClientDeploymentStatus } from "@/server/services/deployments";
import { cuidParamSchema } from "@/server/validation/admin";
import { fromError, fail, ok } from "@/server/http";

/**
 * Client read: grant-scoped managed-deployment status metadata ONLY.
 * Never returns compose source/canonical, environment, secret references,
 * secret metadata, or finding internals.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const session = await requireApiRole("CLIENT");
    const id = cuidParamSchema.parse((await params).id);
    const status = await getClientDeploymentStatus(session, id);
    if (!status) return fail("NOT_FOUND", "Workload not found", 404);
    return ok(status);
  } catch (error) {
    return fromError(error);
  }
}
