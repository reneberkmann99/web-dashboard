import { requireApiRole } from "@/server/auth/guards";
import { collectWorkloads } from "@/server/services/overview";
import { fromError, ok } from "@/server/http";

export async function GET(request: Request): Promise<Response> {
  try {
    await requireApiRole("ADMIN");
    const url = new URL(request.url);
    const clientId = url.searchParams.get("clientId") ?? undefined;
    const nodeId = url.searchParams.get("nodeId") ?? undefined;

    let workloads = await collectWorkloads();
    if (clientId) workloads = workloads.filter((w) => w.clientId === clientId);
    if (nodeId) workloads = workloads.filter((w) => w.nodeId === nodeId);

    return ok({ workloads });
  } catch (error) {
    return fromError(error);
  }
}
