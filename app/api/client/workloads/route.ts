import { requireApiRole } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { fromError, fail, ok } from "@/server/http";
import { collectWorkloads } from "@/server/services/overview";

export async function GET(): Promise<Response> {
  try {
    const session = await requireApiRole("CLIENT");
    if (!session.clientAccountId) {
      return fail("FORBIDDEN", "No client account", 403);
    }
    const clientId = session.clientAccountId;

    // Workloads the client may see: projects granted to it, or projects
    // containing containers granted to it.
    const grantedProjectIds = await prisma.accessGrant.findMany({
      where: { clientAccountId: clientId, isActive: true, projectId: { not: null } },
      select: { projectId: true }
    });
    const idSet = new Set(grantedProjectIds.map((g) => g.projectId).filter((v): v is string => !!v));

    const all = await collectWorkloads();
    const visible = all.filter((w) => w.clientId === clientId || (w.id && idSet.has(w.id)));
    return ok({ workloads: visible });
  } catch (error) {
    return fromError(error);
  }
}
