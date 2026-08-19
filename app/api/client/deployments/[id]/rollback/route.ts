import { requireApiCapability } from "@/server/auth/guards";
import { requestDeploymentOperation, getRollbackTarget } from "@/server/services/deployment-executor";
import { requireClientDeployment } from "@/server/services/client-deployments";
import { rollbackSchema } from "@/server/validation/deployment";
import { fromError, fail, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const session = await requireApiCapability("deployment.deploy");
    const sourceIp = getSourceIpFromRequest(request);
    const { id } = await params;
    await requireClientDeployment(session, id, "deployment.deploy");
    const body = rollbackSchema.parse(await request.json());

    const revisionId = body.revisionId ?? (await getRollbackTarget(id))?.revisionId ?? null;
    if (!revisionId) return fail("NOT_FOUND", "No rollback target found", 404);

    const result = await requestDeploymentOperation({
      deploymentId: id,
      type: "ROLLBACK",
      revisionId,
      planHash: body.planHash,
      actor: session,
      sourceIp
    });

    switch (result.status) {
      case "deployment_not_found":
        return fail("NOT_FOUND", "Deployment not found", 404);
      case "revision_not_found":
        return fail("NOT_FOUND", "Revision not found", 404);
      case "execution_unsupported":
        return fail("EXECUTION_UNSUPPORTED", result.reason, 422);
      case "deployment_op_in_progress":
        return fail("DEPLOYMENT_OP_IN_PROGRESS", "A deployment operation is already in progress", 409);
      case "container_op_in_progress":
        return fail("CONTAINER_OP_IN_PROGRESS", "A container operation is in progress on this workload", 409);
      case "plan_stale":
        return fail("PLAN_STALE", "The plan is stale; review the latest plan and re-confirm", 409);
      case "security_blocked":
        return fail("SECURITY_BLOCKED", "The revision has BLOCKED findings under the current policy", 422, { ruleIds: result.ruleIds });
      case "security_ack_required":
        return fail("SECURITY_ACK_REQUIRED", "HIGH_RISK findings require acknowledgement", 422, { ruleIds: result.ruleIds });
      case "missing_secret":
        return fail("MISSING_SECRET", "One or more secret values are missing", 422, { keys: result.keys });
      case "created":
        return ok({ operationId: result.operationId }, 202);
    }
  } catch (error) {
    return fromError(error);
  }
}
