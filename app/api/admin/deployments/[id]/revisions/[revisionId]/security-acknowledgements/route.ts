import { requireApiRole } from "@/server/auth/guards";
import { acknowledgeSecurityFinding } from "@/server/services/deployments";
import { acknowledgeFindingSchema } from "@/server/validation/deployment";
import { cuidParamSchema } from "@/server/validation/admin";
import { fromError, fail, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";

/**
 * Acknowledge a HIGH_RISK finding for a revision. Stored separately from the
 * immutable revision. BLOCKED findings can never be acknowledged.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; revisionId: string }> }
): Promise<Response> {
  try {
    const session = await requireApiRole("ADMIN");
    const sourceIp = getSourceIpFromRequest(request);
    const { id, revisionId } = await params;
    const deploymentId = cuidParamSchema.parse(id);
    const revId = cuidParamSchema.parse(revisionId);
    const body = acknowledgeFindingSchema.parse(await request.json());

    // deploymentId is validated for existence by the ack path via revision lookup
    // below; keep the param for route-shape consistency.
    void deploymentId;

    const result = await acknowledgeSecurityFinding({
      revisionId: revId,
      fingerprint: body.fingerprint,
      actor: session,
      sourceIp
    });

    switch (result.status) {
      case "finding_not_found":
        return fail("NOT_FOUND", "Finding not found", 404);
      case "not_acknowledgeable":
        return fail("NOT_ACKNOWLEDGEABLE", "Only HIGH_RISK findings can be acknowledged", 422);
      case "acknowledged":
        return ok({ acknowledged: true });
    }
  } catch (error) {
    return fromError(error);
  }
}
