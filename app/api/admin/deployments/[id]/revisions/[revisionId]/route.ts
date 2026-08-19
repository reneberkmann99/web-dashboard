import { requireApiRole } from "@/server/auth/guards";
import { getRevision } from "@/server/services/deployments";
import { cuidParamSchema } from "@/server/validation/admin";
import { fromError, fail, ok } from "@/server/http";

/** Get a single revision including its full (secret-free) definition. ADMIN only. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; revisionId: string }> }
): Promise<Response> {
  try {
    await requireApiRole("ADMIN");
    const { id, revisionId } = await params;
    const deploymentId = cuidParamSchema.parse(id);
    const revId = cuidParamSchema.parse(revisionId);

    const revision = await getRevision(deploymentId, revId);
    if (!revision) return fail("NOT_FOUND", "Revision not found", 404);
    return ok(revision);
  } catch (error) {
    return fromError(error);
  }
}
