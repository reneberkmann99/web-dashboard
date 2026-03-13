import { ensureRole, requireApiSession } from "@/server/auth/guards";
import { runContainerAction } from "@/server/services/containers";
import { fail, fromError, ok } from "@/server/http";
import { containerActionSchema } from "@/server/validation/admin";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const { id } = await params;
    const session = await requireApiSession();
    ensureRole(session, ["CLIENT"]);

    const body = containerActionSchema.parse(await request.json());
    const sourceIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

    const success = await runContainerAction(session, id, body.action, sourceIp);
    if (!success) {
      return fail("ACTION_DENIED", "Action is not allowed for this container", 403);
    }

    return ok({ success: true });
  } catch (error) {
    return fromError(error);
  }
}
