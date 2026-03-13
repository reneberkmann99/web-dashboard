import { ensureRole, requireApiSession } from "@/server/auth/guards";
import { buildOverview, listContainersForSession } from "@/server/services/containers";
import { fromError, ok } from "@/server/http";

export async function GET(): Promise<Response> {
  try {
    const session = await requireApiSession();
    ensureRole(session, ["CLIENT"]);

    const containers = await listContainersForSession(session);
    return ok({
      overview: buildOverview(containers),
      recentContainers: containers.slice(0, 8)
    });
  } catch (error) {
    return fromError(error);
  }
}
