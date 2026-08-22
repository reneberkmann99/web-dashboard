import { requireApiCapability } from "@/server/auth/guards";
import { fromError, ok } from "@/server/http";
import { listNotificationDeliveries } from "@/server/services/notifications";

/** CLIENT_ADMIN: delivery history for the caller's own organization's destinations only. */
export async function GET(request: Request): Promise<Response> {
  try {
    const actor = await requireApiCapability("alerting.manage");
    const limit = Math.min(Number(new URL(request.url).searchParams.get("limit") ?? 100) || 100, 200);
    return ok({ deliveries: await listNotificationDeliveries(actor, limit) });
  } catch (error) {
    return fromError(error);
  }
}
