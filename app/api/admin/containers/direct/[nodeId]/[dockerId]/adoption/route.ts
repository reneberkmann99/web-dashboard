import { z } from "zod";
import { requireApiCapability } from "@/server/auth/guards";
import { cuidParamSchema } from "@/server/validation/admin";
import { fromError, fail, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";
import { adoptContainer, previewContainerAdoption } from "@/server/services/container-adoption";

/**
 * Manual standalone-container adoption.
 *
 * GET  — preflight: full `docker inspect` via the node agent, per-field
 *        PASS/WARNING/BLOCKER verdicts, synthesized compose definition.
 *        Read-only — nothing is written, nothing is restarted.
 * POST — adopt: creates the workload/deployment/revision through the standard
 *        engine, associates the container, labels the LIVE container (labels
 *        only, no recreation), marks the runtime CONVERGED.
 *
 * ADMIN only (workload.adopt). BLOCKERs refuse adoption; high-risk findings
 * require explicit acknowledgement in the POST body.
 */

const adoptContainerSchema = z
  .object({
    name: z.string().min(2).max(120).optional(),
    slug: z.string().min(2).max(60).regex(/^[a-z0-9-]+$/).optional(),
    description: z.string().max(500).nullable().optional(),
    clientAccountId: z.string().cuid().nullable().optional(),
    acknowledgedFindings: z.array(z.string()).default([])
  });

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ nodeId: string; dockerId: string }> }
): Promise<Response> {
  try {
    await requireApiCapability("workload.view");
    const { nodeId, dockerId } = await params;
    const preview = await previewContainerAdoption(cuidParamSchema.parse(nodeId), dockerId);
    if (!preview) return fail("NOT_FOUND", "Node not found", 404);
    return ok(preview);
  } catch (error) {
    return fromError(error);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ nodeId: string; dockerId: string }> }
): Promise<Response> {
  try {
    const session = await requireApiCapability("workload.adopt");
    const { nodeId, dockerId } = await params;
    const body = adoptContainerSchema.parse(await request.json());

    const result = await adoptContainer({
      nodeId: cuidParamSchema.parse(nodeId),
      dockerContainerId: dockerId,
      name: body.name,
      slug: body.slug,
      description: body.description,
      clientAccountId: body.clientAccountId,
      acknowledgedFindings: body.acknowledgedFindings,
      actor: session,
      sourceIp: getSourceIpFromRequest(request)
    });

    switch (result.status) {
      case "adopted":
        return ok(result, 201);
      case "already_managed":
        return fail("ALREADY_MANAGED", `This container already belongs to workload "${result.workloadName}"`, 409, {
          workloadId: result.workloadId
        });
      case "blocked":
        return fail("ADOPTION_BLOCKED", "This container cannot be adopted safely", 422, { blockers: result.blockers });
      case "node_offline":
        return fail("NODE_OFFLINE", "The node is offline — cannot adopt right now", 503);
      case "compose_unavailable":
        return fail("COMPOSE_UNAVAILABLE", "Docker Compose v2 is not available on this node", 503);
      case "invalid":
        return fail("INVALID_DEFINITION", "The reproduced definition is not valid", 422, {
          findings: result.findings,
          composeErrors: result.composeErrors
        });
      case "ack_required":
        return fail("ACK_REQUIRED", "High-risk findings require acknowledgement", 409, {
          highRiskFindings: result.highRiskFindings
        });
    }
  } catch (error) {
    return fromError(error);
  }
}
