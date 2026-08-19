import { requireApiCapability } from "@/server/auth/guards";
import { cuidParamSchema } from "@/server/validation/admin";
import { fromError, fail, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";
import { reissueInvite, setTeamUserActive } from "@/server/services/client-team";

/**
 * CLIENT_ADMIN per-user operations on their own client:
 *  - PATCH  { isActive }  → deactivate/reactivate an operator/viewer
 *  - POST   { action: "reinvite" } → reissue a pending activation link
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const session = await requireApiCapability("user.manage");
    const sourceIp = getSourceIpFromRequest(request);
    const id = cuidParamSchema.parse((await params).id);

    const body = (await request.json()) as { isActive?: boolean };
    if (typeof body.isActive !== "boolean") {
      return fail("VALIDATION_ERROR", "isActive must be a boolean", 400);
    }

    const changed = await setTeamUserActive(session, id, body.isActive, sourceIp);
    if (!changed) {
      return fail("NOT_FOUND", "User not found or cannot be modified", 404);
    }
    return ok({ success: true });
  } catch (error) {
    return fromError(error);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const session = await requireApiCapability("user.manage");
    const sourceIp = getSourceIpFromRequest(request);
    const id = cuidParamSchema.parse((await params).id);

    const body = (await request.json()) as { action?: string };
    if (body.action !== "reinvite") {
      return fail("VALIDATION_ERROR", "Unsupported action", 400);
    }

    const result = await reissueInvite(session, id, sourceIp);
    if (!result) {
      return fail("NOT_FOUND", "User not found or already active", 404);
    }
    return ok(result);
  } catch (error) {
    return fromError(error);
  }
}
