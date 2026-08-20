import { requireApiRole } from "@/server/auth/guards";
import { fromError, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";
import { createNotificationDestination, listNotificationDestinations } from "@/server/services/notifications";
import { notificationDestinationCreateSchema } from "@/server/validation/attention-lifecycle";

export async function GET(): Promise<Response> {
  try {
    await requireApiRole("ADMIN");
    return ok({ destinations: await listNotificationDestinations() });
  } catch (error) {
    return fromError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const actor = await requireApiRole("ADMIN");
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
