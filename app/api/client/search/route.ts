import { requireApiRole } from "@/server/auth/guards";
import { searchForClient } from "@/server/services/search";
import { fromError, ok } from "@/server/http";

/** Tenant-scoped global search for client roles: workloads + containers only. */
export async function GET(request: Request): Promise<Response> {
  try {
    const session = await requireApiRole("CLIENT");
    const q = new URL(request.url).searchParams.get("q") ?? "";
    const groups = await searchForClient(session, q);
    return ok({ groups });
  } catch (error) {
    return fromError(error);
  }
}
