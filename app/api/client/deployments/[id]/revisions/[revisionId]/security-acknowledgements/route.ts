import { requireApiCapability } from "@/server/auth/guards";
import { acknowledgeSecurityFinding } from "@/server/services/deployments";
import { requireClientDeployment } from "@/server/services/client-deployments";
import { acknowledgeFindingSchema } from "@/server/validation/deployment";
import { fromError, fail, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; revisionId: string }> }
): Promise<Response> {
  try {
    const session = await requireApiCapability("deployment.manage");
    const sourceIp = getSourceIpFromRequest(request);
    const { id, revisionId } = await params;
    await requireClientDeployment(session, id, "deployment.manage");
    const body = acknowledgeFindingSchema.parse(await request.json());

    const result = await acknowledgeSecurityFinding({ revisionId, fingerprint: body.fingerprint, actor: session, sourceIp });
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
