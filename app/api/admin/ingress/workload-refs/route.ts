import { requireApiRole } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { fromError, ok } from "@/server/http";

/**
 * Lightweight workload/container picker for the ingress endpoint create
 * form — intentionally separate from server/services/overview.ts (which does
 * live Docker sync work this picker doesn't need) and keyed by our own
 * Container.id (what IngressEndpoint.containerId actually references), not
 * a raw dockerContainerId.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    await requireApiRole("ADMIN");
    const clientAccountId = new URL(request.url).searchParams.get("clientAccountId");
    if (!clientAccountId) return ok({ workloads: [] });

    const workloads = await prisma.project.findMany({
      where: { clientAccountId, isActive: true },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        containers: { where: { isActive: true }, orderBy: { dockerName: "asc" }, select: { id: true, dockerName: true, composeService: true } }
      }
    });
    return ok({ workloads });
  } catch (error) {
    return fromError(error);
  }
}
