import { requireApiCapability } from "@/server/auth/guards";
import { getDeploymentReleaseDetail } from "@/server/services/deployment-releases";
import { requireClientDeployment } from "@/server/services/client-deployments";
import { fromError, fail, ok } from "@/server/http";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; releaseId: string }> }
): Promise<Response> {
  try {
    const session = await requireApiCapability("deployment.view");
    const { id, releaseId } = await params;
    await requireClientDeployment(session, id, "deployment.view");
    const release = await getDeploymentReleaseDetail(id, releaseId);
    if (!release) return fail("NOT_FOUND", "Release not found", 404);
    return ok(release);
  } catch (error) {
    return fromError(error);
  }
}
