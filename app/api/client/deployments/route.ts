import { requireApiCapability } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { createDeployment } from "@/server/services/deployments";
import { listAllowedNodesForClient } from "@/server/services/client-nodes";
import { createDeploymentSchema } from "@/server/validation/deployment";
import { fromError, fail, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";

/**
 * CLIENT self-service: create a new managed workload on one of the caller's
 * allowlisted nodes. Forces clientAccountId = caller's own client (never
 * client-supplied) and validates the node against ClientNodeAccess server-
 * side. Authored under STRICT (CLIENT) security policy — sandbox-boundary
 * findings (privileged, host bind/net/pid/ipc, docker socket, caps, devices,
 * security-opt, sysctls, external networks/volumes) are BLOCKED, not
 * acknowledgeable.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const session = await requireApiCapability("project.create");
    if (!session.clientAccountId) return fail("FORBIDDEN", "No client account", 403);
    const sourceIp = getSourceIpFromRequest(request);
    const body = createDeploymentSchema.parse(await request.json());

    const allowed = await listAllowedNodesForClient(session.clientAccountId);
    if (!allowed.some((n) => n.nodeId === body.nodeId)) {
      return fail("NODE_NOT_ALLOWED", "Your account is not allowed to deploy on this node", 403);
    }

    const result = await createDeployment({
      ...body,
      clientAccountId: session.clientAccountId,
      policy: "CLIENT",
      actor: session,
      sourceIp
    });

    switch (result.status) {
      case "node_not_found":
        return fail("NOT_FOUND", "Node not found", 404);
      case "compose_unavailable":
        return fail("COMPOSE_UNAVAILABLE", result.message, 422);
      case "invalid":
        return fail("DEPLOYMENT_INVALID", "Configuration is invalid", 422, {
          findings: result.findings,
          composeErrors: result.composeErrors
        });
      case "ack_required":
        // Should not normally occur under strict policy (sandbox rules are
        // BLOCKED, not HIGH_RISK) but non-sandbox HIGH_RISK rules (e.g.
        // published-ports is INFO, cap-add non-dangerous is WARNING) may
        // still require acknowledgement.
        return fail("SECURITY_ACK_REQUIRED", "Findings must be acknowledged before saving", 422, {
          highRiskFindings: result.highRiskFindings
        });
      case "compose_project_taken":
        return fail("COMPOSE_PROJECT_TAKEN", `Compose project name is already in use`, 409);
      case "created":
        return ok(
          { id: result.deploymentId, projectId: result.projectId, revisionId: result.revisionId, revisionNumber: result.revisionNumber },
          201
        );
    }
  } catch (error) {
    return fromError(error);
  }
}
