import { requireApiRole } from "@/server/auth/guards";
import { cuidParamSchema } from "@/server/validation/admin";
import { fromError, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";
import { resendUserActivation } from "@/server/services/user-lifecycle";
import { sendInvitationEmail } from "@/server/services/mail";

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
    const emailDelivery = await sendInvitationEmail({
      to: result.recipient.email,
      displayName: result.recipient.displayName,
      activationUrl: result.activationUrl,
      activationExpiresAt: result.activationExpiresAt
    });
    return ok({
      activationUrl: result.activationUrl,
      activationExpiresAt: result.activationExpiresAt,
      emailDelivery
    });
  } catch (error) {
    return fromError(error);
  }
}
