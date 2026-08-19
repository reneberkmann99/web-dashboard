import { requireApiCapability } from "@/server/auth/guards";
import { restartWorkload } from "@/server/services/workloads";
import { cuidParamSchema } from "@/server/validation/admin";
import { fail, fromError, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";
import { logAuditEvent } from "@/server/audit";

/**
 * Restart a workload (all of its containers) as a batch of tracked operations.
 * ADMIN-only.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const session = await requireApiCapability("platform.admin");
    const sourceIp = getSourceIpFromRequest(request);
    const id = cuidParamSchema.parse((await params).id);

    const result = await restartWorkload(id, session);
    if (!result) {
      return fail("NOT_FOUND", "Workload not found", 404);
    }

    await logAuditEvent({
      actorUserId: session.userId,
      actorEmail: session.email,
      actorRole: session.role,
      action: "WORKLOAD_RESTART",
      targetType: "PROJECT",
      targetId: id,
      metadata: { total: result.total, operationIds: result.operationIds, failures: result.failures.length },
      result: result.failures.length === result.total ? "FAILURE" : "SUCCESS",
      sourceIp
    });

    return ok(result, 202);
  } catch (error) {
    return fromError(error);
  }
}
