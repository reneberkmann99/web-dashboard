import { requireApiRole } from "@/server/auth/guards";
import { cuidParamSchema } from "@/server/validation/admin";
import { fail, fromError, ok } from "@/server/http";
import { buildWorkloadDeletionPlan } from "@/server/services/workload-lifecycle";

/**
 * GET /api/admin/workloads/:id/deletion-plan — read-only preview of what a
 * delete would do (containers removed, grants revoked, volumes/networks kept).
 */
export async function GET(
  _: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    await requireApiRole("ADMIN");
    const id = cuidParamSchema.parse((await params).id);
    const plan = await buildWorkloadDeletionPlan(id);
    if (!plan) {
      return fail("NOT_FOUND", "Workload not found", 404);
    }
    return ok(plan);
  } catch (error) {
    return fromError(error);
  }
}
