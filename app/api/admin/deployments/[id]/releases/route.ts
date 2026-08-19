import { requireApiRole } from "@/server/auth/guards";
import { listDeploymentReleases } from "@/server/services/deployment-releases";
import { cuidParamSchema } from "@/server/validation/admin";
import { fromError, fail, ok } from "@/server/http";

/**
 * List release history for a managed deployment (ADMIN, newest first).
 * Metadata only — never secret plaintext or ciphertext.
 * Query: ?limit=50&offset=0 (limit capped at 200).
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    await requireApiRole("ADMIN");
    const id = cuidParamSchema.parse((await params).id);

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
