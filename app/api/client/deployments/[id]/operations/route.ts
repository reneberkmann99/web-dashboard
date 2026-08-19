import { requireApiCapability } from "@/server/auth/guards";
import { listClientDeploymentOperations, requireClientDeployment } from "@/server/services/client-deployments";
import { fromError, ok } from "@/server/http";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const session = await requireApiCapability("deployment.view");
    const { id } = await params;
    await requireClientDeployment(session, id, "deployment.view");
    const operations = await listClientDeploymentOperations(id);
    return ok({ data: operations, total: operations.length });
  } catch (error) {
    return fromError(error);
  }
}
