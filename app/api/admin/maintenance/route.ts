import { requireApiRole } from "@/server/auth/guards";
import { fromError, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";
import { listMaintenanceWindows, scheduleMaintenance } from "@/server/services/attention-lifecycle";
import { maintenanceSchema } from "@/server/validation/attention-lifecycle";

export async function GET(): Promise<Response> {
  try {
    await requireApiRole("ADMIN");
    return ok({ windows: await listMaintenanceWindows() });
  } catch (error) {
    return fromError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const actor = await requireApiRole("ADMIN");
    const body = maintenanceSchema.parse(await request.json());
    const window = await scheduleMaintenance({
      ...body,
      actor,
      sourceIp: getSourceIpFromRequest(request)
    });
    return ok({ window }, 201);
  } catch (error) {
    return fromError(error);
  }
}
