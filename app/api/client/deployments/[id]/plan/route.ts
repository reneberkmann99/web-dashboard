import { requireApiCapability } from "@/server/auth/guards";
import { generateDeploymentPlan, getLatestRevisionId } from "@/server/services/deployment-plan";
import { requireClientDeployment } from "@/server/services/client-deployments";
import { planSchema } from "@/server/validation/deployment";
import { fromError, fail, ok } from "@/server/http";
import { logAuditEvent } from "@/server/audit";
import { getSourceIpFromRequest } from "@/server/request";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const session = await requireApiCapability("deployment.manage");
    const sourceIp = getSourceIpFromRequest(request);
    const { id } = await params;
    await requireClientDeployment(session, id, "deployment.manage");
    const body = planSchema.parse(await request.json());

    const revisionId = body.revisionId ?? (await getLatestRevisionId(id));
    if (!revisionId) return fail("NOT_FOUND", "No revision found for this deployment", 404);

    const plan = await generateDeploymentPlan({ deploymentId: id, revisionId });
    if (!plan) return fail("NOT_FOUND", "Deployment or revision not found", 404);

    await logAuditEvent({
      actorUserId: session.userId,
      actorEmail: session.email,
      actorRole: session.role,
      clientAccountId: session.clientAccountId ?? null,
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
