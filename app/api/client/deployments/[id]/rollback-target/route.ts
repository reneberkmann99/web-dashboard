import { requireApiCapability } from "@/server/auth/guards";
import { getRollbackTarget } from "@/server/services/deployment-executor";
import { requireClientDeployment } from "@/server/services/client-deployments";
import { fromError, fail, ok } from "@/server/http";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const session = await requireApiCapability("deployment.view");
    const { id } = await params;
    await requireClientDeployment(session, id, "deployment.view");
    const target = await getRollbackTarget(id);
    if (!target) return fail("NOT_FOUND", "No rollback target found", 404);
    return ok(target);
  } catch (error) {
    return fromError(error);
  }
}
