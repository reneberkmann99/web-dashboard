import { ensureRole, requireApiSession } from "@/server/auth/guards";
import { getContainerByAssignmentId } from "@/server/services/containers";
import { fail, fromError, ok } from "@/server/http";

export async function GET(
  _: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const { id } = await params;
    const session = await requireApiSession();
    ensureRole(session, ["CLIENT"]);

    const container = await getContainerByAssignmentId(session, id);
    if (!container) {
      return fail("NOT_FOUND", "Container not found", 404);
    }

    return ok({ container });
  } catch (error) {
    return fromError(error);
  }
}
