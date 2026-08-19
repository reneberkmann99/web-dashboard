import { requireApiRole } from "@/server/auth/guards";
import { getDeployment } from "@/server/services/deployments";
import { cuidParamSchema } from "@/server/validation/admin";
import { fromError, fail, ok } from "@/server/http";

/** Get a managed deployment definition (ADMIN read). */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    await requireApiRole("ADMIN");
    const id = cuidParamSchema.parse((await params).id);
    const deployment = await getDeployment(id);
    if (!deployment) return fail("NOT_FOUND", "Deployment not found", 404);
    return ok(deployment);
  } catch (error) {
    return fromError(error);
  }
}
