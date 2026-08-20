import { requireApiRole } from "@/server/auth/guards";
import { createDeployment } from "@/server/services/deployments";
import { createDeploymentSchema } from "@/server/validation/deployment";
import { fromError, fail, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";

/**
 * Create a NEW Noderaft-managed deployment definition (authoring only).
 * Creates a COMPOSE Project + Deployment + immutable Revision #1 + findings +
 * acknowledgements. NO Docker workload is created or mutated in any way.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const session = await requireApiRole("ADMIN");
    const sourceIp = getSourceIpFromRequest(request);
    const body = createDeploymentSchema.parse(await request.json());

    const result = await createDeployment({ ...body, actor: session, sourceIp });

    switch (result.status) {
      case "node_not_found":
        return fail("NOT_FOUND", "Node not found", 404);
      case "compose_unavailable":
        return fail("COMPOSE_UNAVAILABLE", result.message, 422);
      case "invalid":
        return fail("DEPLOYMENT_INVALID", "Deployment definition is invalid", 422, {
          findings: result.findings,
          composeErrors: result.composeErrors
        });
      case "ack_required":
        return fail(
          "SECURITY_ACK_REQUIRED",
          "HIGH_RISK findings must be acknowledged before saving",
          422,
          { highRiskFindings: result.highRiskFindings }
        );
      case "compose_project_taken":
        return fail(
          "COMPOSE_PROJECT_TAKEN",
          `Compose project is already in use by "${result.existingName}"`,
          409
        );
      case "created":
        return ok(
          {
            id: result.deploymentId,
            projectId: result.projectId,
            revisionId: result.revisionId,
            revisionNumber: result.revisionNumber
          },
          201
        );
    }
  } catch (error) {
    return fromError(error);
  }
}
