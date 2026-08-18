import { requireApiRole } from "@/server/auth/guards";
import { getContainerLogs } from "@/server/services/containers";
import { cuidParamSchema } from "@/server/validation/admin";
import { fail, fromError, ok } from "@/server/http";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const id = cuidParamSchema.parse((await params).id);
    const session = await requireApiRole("CLIENT");

    const tail = Number(new URL(request.url).searchParams.get("tail") ?? "200");
    const result = await getContainerLogs(session, id, Number.isNaN(tail) ? 200 : Math.min(tail, 500));

    if (!result) {
      return fail("NOT_FOUND", "Container not found", 404);
    }
    if (!result.allowed) {
      return fail("ACTION_DENIED", "Viewing logs is not permitted for this container", 403);
    }

    return ok({ logs: result.logs, nodeOnline: result.nodeOnline });
  } catch (error) {
    return fromError(error);
  }
}
