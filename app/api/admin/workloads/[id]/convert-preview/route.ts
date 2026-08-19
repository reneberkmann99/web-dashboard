import { requireApiRole } from "@/server/auth/guards";
import { previewConvertToCompose } from "@/server/services/compose";
import { cuidParamSchema } from "@/server/validation/admin";
import { fail, fromError, ok } from "@/server/http";

/**
 * Preview whether a MANUAL workload can be safely converted to a
 * COMPOSE-managed workload. Returns eligibility + what would change.
 */
export async function GET(
  _: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    await requireApiRole("ADMIN");
    const id = cuidParamSchema.parse((await params).id);

    const preview = await previewConvertToCompose(id);
    if (!preview) {
      return fail("NOT_FOUND", "Workload not found", 404);
    }
    return ok({ preview });
  } catch (error) {
    return fromError(error);
  }
}
