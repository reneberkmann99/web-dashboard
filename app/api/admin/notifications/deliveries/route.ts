import { requireApiRole } from "@/server/auth/guards";
import { fromError, ok } from "@/server/http";
import { listNotificationDeliveries } from "@/server/services/notifications";

export async function GET(request: Request): Promise<Response> {
  try {
    await requireApiRole("ADMIN");
    const limit = Math.min(Number(new URL(request.url).searchParams.get("limit") ?? 100) || 100, 200);
    return ok({ deliveries: await listNotificationDeliveries(limit) });
  } catch (error) {
    return fromError(error);
  }
}
