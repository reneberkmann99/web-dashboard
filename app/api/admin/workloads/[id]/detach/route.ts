import { requireApiRole } from "@/server/auth/guards";
import { detachComposeTracking } from "@/server/services/compose";
import { cuidParamSchema } from "@/server/validation/admin";
import { fail, fromError, ok } from "@/server/http";
import { logAuditEvent } from "@/server/audit";
import { getSourceIpFromRequest } from "@/server/request";

/**
 * Detach a COMPOSE workload from automatic reconciliation (source → MANUAL,
 * composeProject → null). Pure DB update — never stops/deletes containers,
 * volumes, networks, or runs `docker compose down`. Explicitly documented in
 * the confirmation dialog on the client side.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const session = await requireApiRole("ADMIN");
    const sourceIp = getSourceIpFromRequest(request);
    const id = cuidParamSchema.parse((await params).id);

    const result = await detachComposeTracking(id);
    if (!result) {
      return fail("NOT_FOUND", "Workload not found or not Compose-managed", 404);
    }

    await logAuditEvent({
      actorUserId: session.userId,
      actorEmail: session.email,
      actorRole: session.role,
      action: "PROJECT_DETACH_COMPOSE",
      targetType: "PROJECT",
      targetId: id,
      metadata: { source: "COMPOSE_TO_MANUAL" },
      result: "SUCCESS",
      sourceIp
    });

    return ok({ id: result.id });
  } catch (error) {
    return fromError(error);
  }
}
