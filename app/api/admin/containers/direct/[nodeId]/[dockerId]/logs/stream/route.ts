import { requireApiRole } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { agentLogsToSSE } from "@/server/services/logs-stream";
import { fail } from "@/server/http";

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,127}$/;

/**
 * Live container logs (SSE) for administrators, addressed by node + docker id.
 * ADMIN-only; no grant resolution needed.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ nodeId: string; dockerId: string }> }
): Promise<Response> {
  await requireApiRole("ADMIN");
  const { nodeId, dockerId } = await params;
  if (!ID_RE.test(dockerId)) {
    return fail("VALIDATION_ERROR", "Invalid container id", 400);
  }

  const node = await prisma.node.findUnique({ where: { id: nodeId } });
  if (!node) {
    return fail("NOT_FOUND", "Node not found", 404);
  }

  const tail = Math.max(1, Math.min(Number(new URL(request.url).searchParams.get("tail") ?? "200"), 500));

  const stream = agentLogsToSSE(node, dockerId, tail);

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    }
  });
}
