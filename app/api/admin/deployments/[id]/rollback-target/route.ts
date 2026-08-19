import { requireApiRole } from "@/server/auth/guards";
import { getRollbackTarget } from "@/server/services/deployment-executor";
import { cuidParamSchema } from "@/server/validation/admin";
import { fromError, fail, ok } from "@/server/http";

/**
 * Resolve the default rollback target for a managed deployment: the revision
 * of the previous HEALTHY release. Read-only; the caller then plans that
 * revision (POST /plan) and executes the rollback (POST /rollback) with the
 * fresh planHash — the same flow the 6C rollback UI will use.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    await requireApiRole("ADMIN");
    const id = cuidParamSchema.parse((await params).id);
    const target = await getRollbackTarget(id);
    if (!target) return fail("NOT_FOUND", "No rollback target found", 404);
    return ok(target);
  } catch (error) {
    return fromError(error);
  }
}
