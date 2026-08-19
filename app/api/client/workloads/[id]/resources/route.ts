import { requireApiRole } from "@/server/auth/guards";
import { canViewWorkloadResources, getWorkloadResources } from "@/server/services/workload-resources";
import { cuidParamSchema } from "@/server/validation/admin";
import { fail, fromError, ok } from "@/server/http";

/**
 * Client: Networks + Volumes for a workload the caller has been granted.
 * Host bind-mount source paths are withheld (sourceHidden=true) at the
 * service layer — never sent to the browser for a CLIENT session.
 */
export async function GET(
  _: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const id = cuidParamSchema.parse((await params).id);
    const session = await requireApiRole("CLIENT");

    const visible = await canViewWorkloadResources(session, id);
    if (!visible) {
      return fail("NOT_FOUND", "Workload not found", 404);
    }

    const resources = await getWorkloadResources(id, session);
    if (!resources) {
      return fail("NOT_FOUND", "Workload not found", 404);
    }
    return ok(resources);
  } catch (error) {
    return fromError(error);
  }
}
