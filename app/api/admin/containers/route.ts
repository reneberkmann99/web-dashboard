import { ensureRole, requireApiSession } from "@/server/auth/guards";
import { listContainersForSession } from "@/server/services/containers";
import { fromError, ok } from "@/server/http";

export async function GET(): Promise<Response> {
  try {
    const session = await requireApiSession();
    ensureRole(session, ["ADMIN"]);

    const containers = await listContainersForSession(session);
    return ok({ containers });
  } catch (error) {
    return fromError(error);
  }
}
