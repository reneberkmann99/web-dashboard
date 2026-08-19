import { requireApiCapability } from "@/server/auth/guards";
import { getDeployment } from "@/server/services/deployments";
import { requireClientDeployment } from "@/server/services/client-deployments";
import { fromError, ok } from "@/server/http";

/** CLIENT: get own managed deployment definition (status + config metadata). */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const session = await requireApiCapability("deployment.view");
    const { id } = await params;
    await requireClientDeployment(session, id, "deployment.view");
    const deployment = await getDeployment(id);
    if (!deployment) throw new Error("NOT_FOUND");
    return ok(deployment);
  } catch (error) {
    return fromError(error);
  }
}
