import { ensureRole, requireApiSession } from "@/server/auth/guards";
import { runContainerAction } from "@/server/services/containers";
import { containerActionSchema } from "@/server/validation/admin";
import { fail, fromError, ok } from "@/server/http";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const { id } = await params;
    const session = await requireApiSession();
    ensureRole(session, ["ADMIN"]);

    const body = containerActionSchema.parse(await request.json());
    const sourceIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

    const success = await runContainerAction(session, id, body.action, sourceIp);
    if (!success) {
      return fail("ACTION_DENIED", "Action denied", 403);
    }

    return ok({ success: true });
  } catch (error) {
    return fromError(error);
  }
}
