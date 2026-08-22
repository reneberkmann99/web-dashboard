import { requireApiRole } from "@/server/auth/guards";
import { fromError, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";
import { createNotificationRule, listNotificationRules } from "@/server/services/notifications";
import { notificationRuleCreateSchema } from "@/server/validation/attention-lifecycle";

export async function GET(): Promise<Response> {
  try {
    const actor = await requireApiRole("ADMIN");
    return ok({ rules: await listNotificationRules(actor) });
  } catch (error) {
    return fromError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const actor = await requireApiRole("ADMIN");
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
