import { requireApiRole } from "@/server/auth/guards";
import { fromError, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";
import { createPublicAddress, listPublicAddresses } from "@/server/services/ingress";
import { publicAddressCreateSchema } from "@/server/validation/ingress";

/** Platform-only (brief: organization users must not see this). */
export async function GET(): Promise<Response> {
  try {
    const actor = await requireApiRole("ADMIN");
    return ok({ addresses: await listPublicAddresses(actor) });
  } catch (error) {
    return fromError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const actor = await requireApiRole("ADMIN");
    const body = publicAddressCreateSchema.parse(await request.json());
    const address = await createPublicAddress({ ...body, actor, sourceIp: getSourceIpFromRequest(request) });
    return ok({ address }, 201);
  } catch (error) {
    return fromError(error);
  }
}
