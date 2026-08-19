import { requireApiCapability } from "@/server/auth/guards";
import { validateDeploymentDefinition } from "@/server/services/deployments";
import { listAllowedNodesForClient } from "@/server/services/client-nodes";
import { validateDeploymentSchema } from "@/server/validation/deployment";
import { fromError, fail, ok } from "@/server/http";

/**
 * CLIENT: read-only validation under STRICT policy. Node must be in the
 * caller's allowlist \u2014 validation never leaks compose-config results for
 * nodes the tenant cannot deploy to.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const session = await requireApiCapability("deployment.manage");
    if (!session.clientAccountId) return fail("FORBIDDEN", "No client account", 403);
    const body = validateDeploymentSchema.parse(await request.json());

    const allowed = await listAllowedNodesForClient(session.clientAccountId);
    if (!allowed.some((n) => n.nodeId === body.nodeId)) {
      return fail("NODE_NOT_ALLOWED", "Your account is not allowed to deploy on this node", 403);
    }

    const result = await validateDeploymentDefinition({ ...body, policy: "CLIENT" });
    return ok({
      nodeFound: result.nodeFound,
      nodeName: result.nodeName,
      composeSupported: result.composeSupported,
      composeVersion: result.composeVersion,
      valid: result.valid,
      findings: result.findings,
      blockedFindings: result.blockedFindings,
      highRiskFindings: result.highRiskFindings,
      composeErrors: result.composeErrors
    });
  } catch (error) {
    return fromError(error);
  }
}
