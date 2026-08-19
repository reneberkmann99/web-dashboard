import { requireApiCapability } from "@/server/auth/guards";
import { listDeploymentReleases } from "@/server/services/deployment-releases";
import { requireClientDeployment } from "@/server/services/client-deployments";
import { fromError, fail, ok } from "@/server/http";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const session = await requireApiCapability("deployment.view");
    const { id } = await params;
    await requireClientDeployment(session, id, "deployment.view");

    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") ?? 50) || 50;
    const offset = Number(url.searchParams.get("offset") ?? 0) || 0;

    const result = await listDeploymentReleases(id, { limit, offset });
    if (!result) return fail("NOT_FOUND", "Deployment not found", 404);
    return ok({
      data: result.data,
      total: result.total,
      runtimeState: result.runtimeState,
      currentReleaseId: result.currentReleaseId,
      lastHealthyReleaseId: result.lastHealthyReleaseId
    });
  } catch (error) {
    return fromError(error);
  }
}
