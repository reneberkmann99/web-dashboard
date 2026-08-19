import { requireApiRole } from "@/server/auth/guards";
import { getWorkloadResources } from "@/server/services/workload-resources";
import { cuidParamSchema } from "@/server/validation/admin";
import { fail, fromError, ok } from "@/server/http";

/** Admin: Networks + Volumes for a workload (read-only, full bind-path visibility). */
export async function GET(
  _: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const id = cuidParamSchema.parse((await params).id);
    const session = await requireApiRole("ADMIN");

    const resources = await getWorkloadResources(id, session);
    if (!resources) {
      return fail("NOT_FOUND", "Workload not found", 404);
    }
    return ok(resources);
  } catch (error) {
    return fromError(error);
  }
}
