import { requireApiRole } from "@/server/auth/guards";
import { generateDeploymentPlan, getLatestRevisionId } from "@/server/services/deployment-plan";
import { planSchema } from "@/server/validation/deployment";
import { cuidParamSchema } from "@/server/validation/admin";
import { fromError, fail, ok } from "@/server/http";
import { logAuditEvent } from "@/server/audit";
import { getSourceIpFromRequest } from "@/server/request";

/**
 * Generate a NON-MUTATING deployment plan for a candidate revision.
 * Never pulls images or mutates Docker.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const session = await requireApiRole("ADMIN");
    const sourceIp = getSourceIpFromRequest(request);
    const id = cuidParamSchema.parse((await params).id);
    const body = planSchema.parse(await request.json());

    const revisionId = body.revisionId ?? (await getLatestRevisionId(id));
    if (!revisionId) return fail("NOT_FOUND", "No revision found for this deployment", 404);

    const plan = await generateDeploymentPlan({ deploymentId: id, revisionId });
    if (!plan) return fail("NOT_FOUND", "Deployment or revision not found", 404);

    await logAuditEvent({
      actorUserId: session.userId,
      actorEmail: session.email,
      actorRole: session.role,
      action: "DEPLOYMENT_PLAN_CREATED",
      targetType: "DEPLOYMENT",
      targetId: id,
      metadata: { revisionId, planHash: plan.planHash, summary: plan.summary },
      result: "SUCCESS",
      sourceIp
    });

    return ok(plan);
  } catch (error) {
    return fromError(error);
  }
}
