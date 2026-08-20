import { requireApiRole } from "@/server/auth/guards";
import { queryAllContainersForAdmin } from "@/server/services/containers";
import { fromError, ok } from "@/server/http";

/**
 * Admin all-containers list with server-side search/filter/sort/pagination.
 * The browser only ever receives a single page.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    await requireApiRole("ADMIN");

    const url = new URL(request.url);
    const result = await queryAllContainersForAdmin({
      search: url.searchParams.get("search") ?? undefined,
      status: url.searchParams.get("status") ?? undefined,
      nodeId: url.searchParams.get("nodeId") ?? undefined,
      clientId: url.searchParams.get("clientId") ?? undefined,
      projectId: url.searchParams.get("projectId") ?? undefined,
      health: url.searchParams.get("health") ?? undefined,
      needsAttention: url.searchParams.get("needsAttention") === "1",
      sort: url.searchParams.get("sort") ?? undefined,
      dir: url.searchParams.get("dir") === "desc" ? "desc" : "asc",
      page: Number(url.searchParams.get("page") ?? "1"),
      limit: Number(url.searchParams.get("limit") ?? "25")
    });

    return ok(result);
  } catch (error) {
    return fromError(error);
  }
}
