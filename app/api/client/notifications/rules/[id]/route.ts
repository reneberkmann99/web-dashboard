import { requireApiCapability } from "@/server/auth/guards";
import { fromError, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";
import { deleteNotificationRule, updateNotificationRule } from "@/server/services/notifications";
import { cuidParamSchema } from "@/server/validation/admin";
import { notificationRuleUpdateSchema } from "@/server/validation/attention-lifecycle";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const actor = await requireApiCapability("alerting.manage");
    const id = cuidParamSchema.parse((await params).id);
    const body = notificationRuleUpdateSchema.parse(await request.json());
    const rule = await updateNotificationRule({
      id,
      ...body,
      actor,
      sourceIp: getSourceIpFromRequest(request)
    });
    return ok({ rule });
  } catch (error) {
    return fromError(error);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const actor = await requireApiCapability("alerting.manage");
    const id = cuidParamSchema.parse((await params).id);
    await deleteNotificationRule({ id, actor, sourceIp: getSourceIpFromRequest(request) });
    return ok({ success: true });
  } catch (error) {
    return fromError(error);
  }
}
