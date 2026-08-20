import { z } from "zod";
import { requireApiRole } from "@/server/auth/guards";
import { adoptComposeProject } from "@/server/services/compose";
import { fromError, fail, ok } from "@/server/http";
import { logAuditEvent } from "@/server/audit";
import { getSourceIpFromRequest } from "@/server/request";

const adoptComposeSchema = z.object({
  nodeId: z.string().cuid(),
  composeProject: z.string().min(1).max(255),
  // Nullable: an adopted workload may be internal (no owning client) until an
  // explicit AccessGrant is created — the wizard's "No client / internal
  // workload" step.
  clientAccountId: z.string().cuid().nullable().optional(),
  name: z.string().min(2).max(120).optional(),
  slug: z.string().min(2).max(60).regex(/^[a-z0-9-]+$/).optional(),
  description: z.string().max(500).nullable().optional(),
  // Explicit, confirmed opt-in required before any container is reassigned
  // away from an existing workload. Never defaulted.
  moveConflictingContainers: z.boolean().optional()
});

/** Adopt a detected Docker Compose project as a Noderaft workload. */
export async function POST(request: Request): Promise<Response> {
  try {
    const session = await requireApiRole("ADMIN");
    const sourceIp = getSourceIpFromRequest(request);
    const body = adoptComposeSchema.parse(await request.json());

    const result = await adoptComposeProject(body);

    switch (result.status) {
      case "not_found":
        return fail("NOT_FOUND", "Compose project not found on this node", 404);
      case "already_adopted":
        return fail("ALREADY_ADOPTED", `Already adopted as workload "${result.workloadName}"`, 409, {
          workloadId: result.workloadId
        });
      case "conflict":
        return fail(
          "COMPOSE_CONFLICT",
          "Some containers already belong to another workload",
          409,
          { conflicts: result.conflicts }
        );
      case "adopted": {
        await logAuditEvent({
          actorUserId: session.userId,
          actorEmail: session.email,
          actorRole: session.role,
          clientAccountId: body.clientAccountId ?? null,
          action: "COMPOSE_ADOPT",
          targetType: "PROJECT",
          targetId: result.id,
          metadata: { source: "COMPOSE", composeProject: body.composeProject, nodeId: body.nodeId },
          result: "SUCCESS",
          sourceIp
        });
        return ok({ id: result.id }, 201);
      }
    }
  } catch (error) {
    return fromError(error);
  }
}
