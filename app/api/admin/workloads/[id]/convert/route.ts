import { requireApiRole } from "@/server/auth/guards";
import { convertToComposeManaged } from "@/server/services/compose";
import { cuidParamSchema } from "@/server/validation/admin";
import { fail, fromError, ok } from "@/server/http";
import { logAuditEvent } from "@/server/audit";
import { getSourceIpFromRequest } from "@/server/request";

/**
 * Convert a MANUAL workload to COMPOSE in place (id/name/client/grants/history
 * retained — plain field update). Only proceeds when the mapping is
 * unambiguous; otherwise returns 409 with the reason.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const session = await requireApiRole("ADMIN");
    const sourceIp = getSourceIpFromRequest(request);
    const id = cuidParamSchema.parse((await params).id);

    const result = await convertToComposeManaged(id);
    if ("error" in result) {
      return fail("CONVERSION_BLOCKED", result.error, 409);
    }

    await logAuditEvent({
      actorUserId: session.userId,
      actorEmail: session.email,
      actorRole: session.role,
      action: "PROJECT_CONVERT_TO_COMPOSE",
      targetType: "PROJECT",
      targetId: id,
      metadata: { source: "MANUAL_TO_COMPOSE" },
      result: "SUCCESS",
      sourceIp
    });

    return ok({ id: result.id });
  } catch (error) {
    return fromError(error);
  }
}
