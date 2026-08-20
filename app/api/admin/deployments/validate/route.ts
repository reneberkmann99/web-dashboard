import { requireApiRole } from "@/server/auth/guards";
import { validateDeploymentDefinition } from "@/server/services/deployments";
import { validateDeploymentSchema } from "@/server/validation/deployment";
import { fromError, ok } from "@/server/http";

/**
 * Read-only managed-deployment validation (Phase 6A). Runs Stage A (Noderaft
 * policy/security analysis) + Stage B (`docker compose config` via the agent,
 * using secret sentinels). Never persists anything, never mutates Docker, and
 * never sends real secret values to the agent.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    await requireApiRole("ADMIN");
    const body = validateDeploymentSchema.parse(await request.json());
    const result = await validateDeploymentDefinition(body);
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
