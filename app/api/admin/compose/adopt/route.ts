import { z } from "zod";
import { requireApiRole } from "@/server/auth/guards";
import { adoptComposeProject } from "@/server/services/compose";
import { fromError, fail, ok } from "@/server/http";
import { logAuditEvent } from "@/server/audit";
import { getSourceIpFromRequest } from "@/server/request";

const adoptComposeSchema = z.object({
  clientAccountId: z.string().cuid(),
  nodeId: z.string().cuid(),
  composeProject: z.string().min(1).max(255),
  name: z.string().min(2).max(120).optional(),
  slug: z.string().min(2).max(60).regex(/^[a-z0-9-]+$/).optional(),
  description: z.string().max(500).nullable().optional()
});

/** Adopt a detected Docker Compose project as a HostPanel workload. */
export async function POST(request: Request): Promise<Response> {
  try {
    const session = await requireApiRole("ADMIN");
    const sourceIp = getSourceIpFromRequest(request);
    const body = adoptComposeSchema.parse(await request.json());

    const created = await adoptComposeProject(body);
    if (!created) {
      return fail("NOT_FOUND", "Compose project not found on this node (or already adopted)", 404);
    }

    await logAuditEvent({
      actorUserId: session.userId,
      actorEmail: session.email,
      actorRole: session.role,
      clientAccountId: body.clientAccountId,
      action: "PROJECT_CREATE",
      targetType: "PROJECT",
      targetId: created.id,
      metadata: { source: "COMPOSE", composeProject: body.composeProject, nodeId: body.nodeId },
      result: "SUCCESS",
      sourceIp
    });

    return ok({ id: created.id }, 201);
  } catch (error) {
    return fromError(error);
  }
}
