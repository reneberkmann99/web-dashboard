import { requireApiCapability } from "@/server/auth/guards";
import { listAllowedNodesForClient } from "@/server/services/client-nodes";
import { fromError, ok } from "@/server/http";

/** CLIENT: nodes this tenant is allowed to deploy workloads on. */
export async function GET(): Promise<Response> {
  try {
    const session = await requireApiCapability("project.create");
    if (!session.clientAccountId) throw new Error("FORBIDDEN");
    const nodes = await listAllowedNodesForClient(session.clientAccountId);
    return ok({ data: nodes, total: nodes.length });
  } catch (error) {
    return fromError(error);
  }
}
