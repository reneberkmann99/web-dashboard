import { requireApiCapability } from "@/server/auth/guards";
import { fromError, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";
import { createNotificationDestination, listNotificationDestinations } from "@/server/services/notifications";
import { notificationDestinationCreateSchema } from "@/server/validation/attention-lifecycle";

/** CLIENT_ADMIN: destinations owned by the caller's own organization (never platform-wide, never another organization's — enforced in server/services/notifications.ts). */
export async function GET(): Promise<Response> {
  try {
    const actor = await requireApiCapability("alerting.manage");
    return ok({ destinations: await listNotificationDestinations(actor) });
  } catch (error) {
    return fromError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const actor = await requireApiCapability("alerting.manage");
    const body = notificationDestinationCreateSchema.parse(await request.json());
    const destination = await createNotificationDestination({
      ...body,
      actor,
      sourceIp: getSourceIpFromRequest(request)
    });
    return ok({ destination }, 201);
  } catch (error) {
    return fromError(error);
  }
}
