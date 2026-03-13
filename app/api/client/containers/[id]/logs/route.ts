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
    const logs = await getContainerLogs(session, id, Number.isNaN(tail) ? 200 : Math.min(tail, 500));

    if (!logs) {
      return fail("NOT_FOUND", "Container not found", 404);
    }

    return ok(logs);
  } catch (error) {
    return fromError(error);
  }
}
