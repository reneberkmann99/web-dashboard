import { requireApiRole } from "@/server/auth/guards";
import { cuidParamSchema } from "@/server/validation/admin";
import { fromError, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";
import { resendUserActivation } from "@/server/services/user-lifecycle";

/**
 * POST /api/admin/users/:id/resend-activation — regenerate the one-time
 * activation token for a still-pending user. The new activation URL is shown
 * exactly once.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const session = await requireApiRole("ADMIN");
    const sourceIp = getSourceIpFromRequest(request);
    const id = cuidParamSchema.parse((await params).id);

    const result = await resendUserActivation(session, id, sourceIp);
    return ok(result);
  } catch (error) {
    return fromError(error);
  }
}
