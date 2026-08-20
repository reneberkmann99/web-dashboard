import { requireApiRole } from "@/server/auth/guards";
import { fail, fromError, ok } from "@/server/http";
import { getAttentionDetail } from "@/server/services/attention-lifecycle";
import { cuidParamSchema } from "@/server/validation/admin";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    await requireApiRole("ADMIN");
    const id = cuidParamSchema.parse((await params).id);
    const detail = await getAttentionDetail(id);
    return detail ? ok(detail) : fail("NOT_FOUND", "Attention condition not found", 404);
  } catch (error) {
    return fromError(error);
  }
}
