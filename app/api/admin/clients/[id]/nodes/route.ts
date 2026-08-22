import { requireApiRole } from "@/server/auth/guards";
import { listClientNodeAccess, setClientNodeAccess } from "@/server/services/client-nodes";
import { cuidParamSchema } from "@/server/validation/admin";
import { fromError, fail, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";
import { z } from "zod";

const setNodesSchema = z.object({
  nodeIds: z.array(z.string().cuid()).max(50)
});

/** ADMIN: list the node allowlist for a client (tenant self-service). */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    await requireApiRole("ADMIN");
    const id = cuidParamSchema.parse((await params).id);
    const nodes = await listClientNodeAccess(id);
    return ok({ data: nodes, total: nodes.length });
  } catch (error) {
    return fromError(error);
  }
}

/** ADMIN: replace the client's node allowlist. Empty list = no self-service nodes. */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const session = await requireApiRole("ADMIN");
    const sourceIp = getSourceIpFromRequest(request);
    const id = cuidParamSchema.parse((await params).id);
    const body = setNodesSchema.parse(await request.json());

    const result = await setClientNodeAccess({
      clientAccountId: id,
      nodeIds: body.nodeIds,
      actor: session,
      sourceIp
    });

    switch (result.status) {
      case "client_not_found":
        return fail("NOT_FOUND", "Organization not found", 404);
      case "node_not_found":
        return fail("NOT_FOUND", `Node ${result.nodeId} not found`, 404);
      case "updated":
        return ok({ nodeIds: result.nodeIds });
    }
  } catch (error) {
    return fromError(error);
  }
}
