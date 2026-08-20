import { requireApiRole } from "@/server/auth/guards";
import { cuidParamSchema } from "@/server/validation/admin";
import { fail, fromError, ok } from "@/server/http";
import { buildContainerDeletePlan } from "@/server/services/container-lifecycle";

/**
 * GET /api/admin/containers/:id/deletion-plan — read-only preview of what a
 * container delete would do (managed vs standalone, volumes preserved).
 */
export async function GET(
  _: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    await requireApiRole("ADMIN");
    const id = cuidParamSchema.parse((await params).id);
    const plan = await buildContainerDeletePlan(id);
    if (!plan) {
      return fail("NOT_FOUND", "Container not found", 404);
    }
    return ok(plan);
  } catch (error) {
    return fromError(error);
  }
}
