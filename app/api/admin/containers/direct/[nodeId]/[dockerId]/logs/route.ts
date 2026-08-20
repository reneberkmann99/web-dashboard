import { requireApiRole } from "@/server/auth/guards";
import { getContainerLogsDirect } from "@/server/services/containers";
import { fail, fromError, ok } from "@/server/http";

/**
 * Historical (non-streaming) logs for an admin-addressed container by node +
 * docker id. Used by the state-aware LogViewer when a container is stopped:
 * a single read, no SSE follow, no reconnect loop.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ nodeId: string; dockerId: string }> }
): Promise<Response> {
  try {
    await requireApiRole("ADMIN");
    const { nodeId, dockerId } = await params;

    const tail = Number(new URL(request.url).searchParams.get("tail") ?? "200");
    const safeTail = Number.isNaN(tail) ? 200 : Math.min(Math.max(tail, 1), 500);

    const result = await getContainerLogsDirect(nodeId, dockerId, safeTail);
    if (!result) {
      return fail("NOT_FOUND", "Container not found", 404);
    }
    return ok({ logs: result.logs, nodeOnline: result.nodeOnline });
  } catch (error) {
    return fromError(error);
  }
}
