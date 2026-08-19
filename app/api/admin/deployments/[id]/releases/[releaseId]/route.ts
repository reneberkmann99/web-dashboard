import { requireApiRole } from "@/server/auth/guards";
import { getDeploymentReleaseDetail } from "@/server/services/deployment-releases";
import { cuidParamSchema } from "@/server/validation/admin";
import { fromError, fail, ok } from "@/server/http";

/** Get one release with full operational context (ADMIN). No secret values. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; releaseId: string }> }
): Promise<Response> {
  try {
    await requireApiRole("ADMIN");
    const { id, releaseId } = await params;
    const deploymentId = cuidParamSchema.parse(id);
    const relId = cuidParamSchema.parse(releaseId);

    const release = await getDeploymentReleaseDetail(deploymentId, relId);
    if (!release) return fail("NOT_FOUND", "Release not found", 404);
    return ok(release);
  } catch (error) {
    return fromError(error);
  }
}
