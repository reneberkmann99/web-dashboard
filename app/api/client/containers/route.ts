import { requireApiRole } from "@/server/auth/guards";
import { listContainersForSession } from "@/server/services/containers";
import { fromError, ok } from "@/server/http";

export async function GET(): Promise<Response> {
  try {
    const session = await requireApiRole("CLIENT");

    const containers = await listContainersForSession(session);
    return ok({ containers });
  } catch (error) {
    return fromError(error);
  }
}
