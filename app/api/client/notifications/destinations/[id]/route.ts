import { requireApiCapability } from "@/server/auth/guards";
import { fromError, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";
import { deleteNotificationDestination, updateNotificationDestination } from "@/server/services/notifications";
import { cuidParamSchema } from "@/server/validation/admin";
import { notificationDestinationUpdateSchema } from "@/server/validation/attention-lifecycle";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const actor = await requireApiCapability("alerting.manage");
    const id = cuidParamSchema.parse((await params).id);
    const body = notificationDestinationUpdateSchema.parse(await request.json());
    const destination = await updateNotificationDestination({
      id,
      ...body,
      actor,
      sourceIp: getSourceIpFromRequest(request)
    });
    return ok({ destination });
  } catch (error) {
    return fromError(error);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const actor = await requireApiCapability("alerting.manage");
    const id = cuidParamSchema.parse((await params).id);
    await deleteNotificationDestination({ id, actor, sourceIp: getSourceIpFromRequest(request) });
    return ok({ success: true });
  } catch (error) {
    return fromError(error);
  }
}
