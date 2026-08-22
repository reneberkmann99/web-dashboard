import { requireApiCapability } from "@/server/auth/guards";
import { fromError, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";
import { createNotificationRule, listNotificationRules } from "@/server/services/notifications";
import { notificationRuleCreateSchema } from "@/server/validation/attention-lifecycle";

/** CLIENT_ADMIN: rules scoped to the caller's own organization only — a PLATFORM-scope body is rejected server-side. */
export async function GET(): Promise<Response> {
  try {
    const actor = await requireApiCapability("alerting.manage");
    return ok({ rules: await listNotificationRules(actor) });
  } catch (error) {
    return fromError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const actor = await requireApiCapability("alerting.manage");
    const body = notificationRuleCreateSchema.parse(await request.json());
    const rule = await createNotificationRule({
      ...body,
      actor,
      sourceIp: getSourceIpFromRequest(request)
    });
    return ok({ rule }, 201);
  } catch (error) {
    return fromError(error);
  }
}
