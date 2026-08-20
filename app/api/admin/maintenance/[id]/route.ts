import { requireApiRole } from "@/server/auth/guards";
import { fromError, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";
import { cancelMaintenance } from "@/server/services/attention-lifecycle";
import { cuidParamSchema } from "@/server/validation/admin";

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const actor = await requireApiRole("ADMIN");
    const window = await cancelMaintenance({
      maintenanceWindowId: cuidParamSchema.parse((await params).id),
      actor,
      sourceIp: getSourceIpFromRequest(request)
    });
    return ok({ window });
  } catch (error) {
    return fromError(error);
  }
}
