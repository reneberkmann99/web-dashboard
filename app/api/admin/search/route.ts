import { requireApiRole } from "@/server/auth/guards";
import { searchForAdmin } from "@/server/services/search";
import { fromError, ok } from "@/server/http";

/** Global search for administrators: workloads, containers, nodes, clients. */
export async function GET(request: Request): Promise<Response> {
  try {
    await requireApiRole("ADMIN");
    const q = new URL(request.url).searchParams.get("q") ?? "";
    const groups = await searchForAdmin(q);
    return ok({ groups });
  } catch (error) {
    return fromError(error);
  }
}
