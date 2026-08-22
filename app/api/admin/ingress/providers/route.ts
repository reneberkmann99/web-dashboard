import { requireApiRole } from "@/server/auth/guards";
import { fromError, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";
import { createIngressProvider, listIngressProviders } from "@/server/services/ingress";
import { ingressProviderCreateSchema } from "@/server/validation/ingress";

export async function GET(): Promise<Response> {
  try {
    const actor = await requireApiRole("ADMIN");
    return ok({ providers: await listIngressProviders(actor) });
  } catch (error) {
    return fromError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const actor = await requireApiRole("ADMIN");
    const body = ingressProviderCreateSchema.parse(await request.json());
    const provider = await createIngressProvider({ ...body, actor, sourceIp: getSourceIpFromRequest(request) });
    return ok({ provider }, 201);
  } catch (error) {
    return fromError(error);
  }
}
