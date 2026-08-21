import { requireApiCapability } from "@/server/auth/guards";
import { cuidParamSchema } from "@/server/validation/admin";
import { serviceNameParamSchema } from "@/server/validation/deployment";
import {
  previewServiceRemoval,
  removeServiceFromWorkload,
  WorkloadServiceError
} from "@/server/services/workload-service-lifecycle";
import { fail, fromError, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";

/**
 * Managed service removal (admin scope).
 *
 * GET  — read-only impact preview (containers removed, networks/volumes/secrets
 *        retained). Never mutates anything.
 * DELETE — authors a NEW REVISION with the service removed. Does NOT deploy and
 *        never issues `docker rm`: the caller must generate a plan and confirm.
 */

function mapError(error: unknown): Response | null {
  if (!(error instanceof WorkloadServiceError)) return null;
  switch (error.message) {
    case "NOT_FOUND":
      return fail("NOT_FOUND", "Resource not found", 404);
    case "SERVICE_NOT_FOUND":
      return fail("SERVICE_NOT_FOUND", "That service is not part of this workload's definition", 404);
    case "NO_REVISION":
      return fail("NO_REVISION", "This workload has no configuration revision yet", 409);
    case "LAST_SERVICE":
      return fail(
        "LAST_SERVICE",
        "This is the workload's only service — delete the whole workload instead of emptying it",
        409
      );
    default:
      return fail("SERVICE_REMOVAL_FAILED", "The service could not be removed safely", 409);
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; serviceName: string }> }
): Promise<Response> {
  try {
    const session = await requireApiCapability("workload.view");
    const { id, serviceName } = await params;
    const impact = await previewServiceRemoval({
      deploymentId: cuidParamSchema.parse(id),
      serviceName: serviceNameParamSchema.parse(decodeURIComponent(serviceName)),
      session,
      scope: "ADMIN"
    });
    return ok(impact);
  } catch (error) {
    return mapError(error) ?? fromError(error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; serviceName: string }> }
): Promise<Response> {
  try {
    const session = await requireApiCapability("workload.edit");
    const { id, serviceName } = await params;
    const result = await removeServiceFromWorkload({
      deploymentId: cuidParamSchema.parse(id),
      serviceName: serviceNameParamSchema.parse(decodeURIComponent(serviceName)),
      session,
      scope: "ADMIN",
      sourceIp: getSourceIpFromRequest(request)
    });
    if (result.status === "invalid") {
      return fail("INVALID_DEFINITION", "The resulting configuration is not valid", 422, {
        composeErrors: result.composeErrors
      });
    }
    if (result.status === "ack_required") {
      return fail("ACK_REQUIRED", "High-risk findings require acknowledgement", 409, {
        highRiskFindings: result.highRiskFindings
      });
    }
    return ok(result, 201);
  } catch (error) {
    return mapError(error) ?? fromError(error);
  }
}
