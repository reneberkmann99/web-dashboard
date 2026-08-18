import { requireApiRole } from "@/server/auth/guards";
import { getOperationForSession } from "@/server/services/operations";
import { cuidParamSchema } from "@/server/validation/admin";
import { fail, fromError, ok } from "@/server/http";

export async function GET(
  _: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const id = cuidParamSchema.parse((await params).id);
    const session = await requireApiRole("ADMIN");

    const operation = await getOperationForSession(session, id);
    if (!operation) {
      return fail("NOT_FOUND", "Operation not found", 404);
    }

    return ok({ operation });
  } catch (error) {
    return fromError(error);
  }
}
