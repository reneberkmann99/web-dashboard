import { requireApiRole } from "@/server/auth/guards";
import { getContainerByGrant } from "@/server/services/containers";
import { cuidParamSchema } from "@/server/validation/admin";
import { fail, fromError, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";
import { deleteContainer } from "@/server/services/container-lifecycle";

export async function GET(
  _: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const id = cuidParamSchema.parse((await params).id);
    const session = await requireApiRole("ADMIN");

    const { container } = await getContainerByGrant(session, id);
    if (!container) {
      return fail("NOT_FOUND", "Container not found", 404);
    }

    return ok({ container });
  } catch (error) {
    return fromError(error);
  }
}

/**
 * DELETE /api/admin/containers/:id — delete a standalone container. Managed
 * workload services are refused (edit the workload revision instead).
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const session = await requireApiRole("ADMIN");
    const sourceIp = getSourceIpFromRequest(request);
    const id = cuidParamSchema.parse((await params).id);

    const plan = await deleteContainer(session, id, sourceIp);
    return ok({ deleted: true, id: plan.containerId, dockerName: plan.dockerName });
  } catch (error) {
    return fromError(error);
  }
}
