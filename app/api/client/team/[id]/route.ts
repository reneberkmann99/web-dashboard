import { requireApiCapability } from "@/server/auth/guards";
import { cuidParamSchema } from "@/server/validation/admin";
import { fromError, fail, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";
import { reissueInvite, removeTeamMembership, setTeamUserActive, setTeamUserRole } from "@/server/services/client-team";

/**
 * CLIENT_ADMIN per-user operations on their own client:
 *  - PATCH  { isActive?, role? }  → lifecycle/role for an operator/viewer
 *  - POST   { action: "reinvite" } → reissue a pending activation link
 *  - DELETE → remove membership while preserving the platform identity/audit
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const session = await requireApiCapability("user.manage");
    const sourceIp = getSourceIpFromRequest(request);
    const id = cuidParamSchema.parse((await params).id);

    const body = (await request.json()) as { isActive?: boolean; role?: "CLIENT_OPERATOR" | "CLIENT_VIEWER" };
    if (typeof body.isActive !== "boolean" && body.role !== "CLIENT_OPERATOR" && body.role !== "CLIENT_VIEWER") {
      return fail("VALIDATION_ERROR", "Provide isActive or an organization role", 400);
    }

    const changed = body.role
      ? await setTeamUserRole(session, id, body.role, sourceIp)
      : await setTeamUserActive(session, id, body.isActive as boolean, sourceIp);
    if (!changed) {
      return fail("NOT_FOUND", "User not found or cannot be modified", 404);
    }
    return ok({ success: true });
  } catch (error) {
    return fromError(error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const session = await requireApiCapability("user.manage");
    const sourceIp = getSourceIpFromRequest(request);
    const id = cuidParamSchema.parse((await params).id);
    const removed = await removeTeamMembership(session, id, sourceIp);
    if (!removed) return fail("NOT_FOUND", "User not found or cannot be removed", 404);
    return ok({ success: true, removed: true });
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
