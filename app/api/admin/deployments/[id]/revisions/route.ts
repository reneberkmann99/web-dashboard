import { requireApiRole } from "@/server/auth/guards";
import { createRevision, listRevisions } from "@/server/services/deployments";
import { createRevisionSchema } from "@/server/validation/deployment";
import { cuidParamSchema } from "@/server/validation/admin";
import { fromError, fail, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";

/** List revisions of a managed deployment (ADMIN). */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    await requireApiRole("ADMIN");
    const id = cuidParamSchema.parse((await params).id);
    const revisions = await listRevisions(id);
    return ok({ data: revisions, total: revisions.length });
  } catch (error) {
    return fromError(error);
  }
}

/** Create a new immutable revision (validate + persist). No deployment execution. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const session = await requireApiRole("ADMIN");
    const sourceIp = getSourceIpFromRequest(request);
    const deploymentId = cuidParamSchema.parse((await params).id);
    const body = createRevisionSchema.parse(await request.json());

    const result = await createRevision({ deploymentId, ...body, actor: session, sourceIp });

    switch (result.status) {
      case "deployment_not_found":
        return fail("NOT_FOUND", "Deployment not found", 404);
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
      case "created":
        return ok(
          {
            revisionId: result.revisionId,
            revisionNumber: result.revisionNumber,
            deduplicated: result.deduplicated
          },
          result.deduplicated ? 200 : 201
        );
    }
  } catch (error) {
    return fromError(error);
  }
}
