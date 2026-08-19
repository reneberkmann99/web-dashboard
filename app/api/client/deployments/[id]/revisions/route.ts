import { requireApiCapability } from "@/server/auth/guards";
import { createRevision, listRevisions } from "@/server/services/deployments";
import { requireClientDeployment } from "@/server/services/client-deployments";
import { createRevisionSchema } from "@/server/validation/deployment";
import { fromError, fail, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const session = await requireApiCapability("deployment.view");
    const { id } = await params;
    await requireClientDeployment(session, id, "deployment.view");
    const revisions = await listRevisions(id);
    return ok({ data: revisions, total: revisions.length });
  } catch (error) {
    return fromError(error);
  }
}

/** CLIENT: create a new immutable revision under STRICT (CLIENT) policy. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const session = await requireApiCapability("deployment.manage");
    const sourceIp = getSourceIpFromRequest(request);
    const { id } = await params;
    await requireClientDeployment(session, id, "deployment.manage");
    const body = createRevisionSchema.parse(await request.json());

    const result = await createRevision({ deploymentId: id, ...body, policy: "CLIENT", actor: session, sourceIp });

    switch (result.status) {
      case "deployment_not_found":
        return fail("NOT_FOUND", "Deployment not found", 404);
      case "compose_unavailable":
        return fail("COMPOSE_UNAVAILABLE", result.message, 422);
      case "invalid":
        return fail("DEPLOYMENT_INVALID", "Configuration is invalid", 422, {
          findings: result.findings,
          composeErrors: result.composeErrors
        });
      case "ack_required":
        return fail("SECURITY_ACK_REQUIRED", "Findings must be acknowledged before saving", 422, {
          highRiskFindings: result.highRiskFindings
        });
      case "created":
        return ok(
          { revisionId: result.revisionId, revisionNumber: result.revisionNumber, deduplicated: result.deduplicated },
          result.deduplicated ? 200 : 201
        );
    }
  } catch (error) {
    return fromError(error);
  }
}
