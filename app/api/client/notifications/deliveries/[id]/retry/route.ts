import { requireApiCapability } from "@/server/auth/guards";
import { fromError, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";
import { retryNotificationDelivery } from "@/server/services/notifications";
import { cuidParamSchema } from "@/server/validation/admin";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const actor = await requireApiCapability("alerting.manage");
    const delivery = await retryNotificationDelivery({
      deliveryId: cuidParamSchema.parse((await params).id),
      actor,
      sourceIp: getSourceIpFromRequest(request)
    });
    return ok({ delivery }, 202);
  } catch (error) {
    return fromError(error);
  }
}
