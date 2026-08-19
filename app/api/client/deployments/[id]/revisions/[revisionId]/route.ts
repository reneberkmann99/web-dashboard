import { requireApiCapability } from "@/server/auth/guards";
import { getRevision } from "@/server/services/deployments";
import { requireClientDeployment } from "@/server/services/client-deployments";
import { fromError, fail, ok } from "@/server/http";

/** CLIENT: get a single revision (full secret-free definition) for own deployment. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; revisionId: string }> }
): Promise<Response> {
  try {
    const session = await requireApiCapability("deployment.view");
    const { id, revisionId } = await params;
    await requireClientDeployment(session, id, "deployment.view");
    const revision = await getRevision(id, revisionId);
    if (!revision) return fail("NOT_FOUND", "Revision not found", 404);
    return ok(revision);
  } catch (error) {
    return fromError(error);
  }
}
