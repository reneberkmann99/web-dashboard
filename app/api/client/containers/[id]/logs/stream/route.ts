import { requireApiRole } from "@/server/auth/guards";
import { resolveLogTarget } from "@/server/services/containers";
import { cuidParamSchema } from "@/server/validation/admin";
import { agentLogsToSSE } from "@/server/services/logs-stream";
import { fail } from "@/server/http";

/**
 * Live container logs (Server-Sent Events) for client roles.
 *
 * Authorization is enforced BEFORE the stream is opened: the grant must belong
 * to the caller's tenant and allow `view_logs`. The browser never connects to
 * the node agent directly.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const id = cuidParamSchema.parse((await params).id);
  const session = await requireApiRole("CLIENT");

  const target = await resolveLogTarget(session, id);
  if (!target) {
    return fail("ACTION_DENIED", "Viewing logs is not permitted for this container", 403);
  }

  const tail = Math.max(1, Math.min(Number(new URL(request.url).searchParams.get("tail") ?? "200"), 500));

  const stream = agentLogsToSSE(target.node, target.dockerContainerId, tail);

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    }
  });
}
