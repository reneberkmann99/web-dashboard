import { requireApiRole } from "@/server/auth/guards";
import { getDiscoveredComposeProjectDetail } from "@/server/services/compose";
import { fail, fromError, ok } from "@/server/http";

/** Full detail for one discovered/adopted Compose project (services, conflicts, topology). */
export async function GET(
  _: Request,
  { params }: { params: Promise<{ nodeId: string; composeProject: string }> }
): Promise<Response> {
  try {
    await requireApiRole("ADMIN");
    const { nodeId, composeProject } = await params;

    const detail = await getDiscoveredComposeProjectDetail(nodeId, decodeURIComponent(composeProject));
    if (!detail) {
      return fail("NOT_FOUND", "Compose project not found on this node", 404);
    }
    return ok({ project: detail });
  } catch (error) {
    return fromError(error);
  }
}
