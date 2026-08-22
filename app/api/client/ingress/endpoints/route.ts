import { requireApiCapability } from "@/server/auth/guards";
import { fromError, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";
import { createIngressEndpoint, listIngressEndpoints } from "@/server/services/ingress";
import { ingressEndpointCreateSchema } from "@/server/validation/ingress";

/** Organization: own ingress endpoints only (server/services/ingress.ts is the sole scope-enforcement point). */
export async function GET(): Promise<Response> {
  try {
    const actor = await requireApiCapability("ingress.view");
    return ok({ endpoints: await listIngressEndpoints(actor) });
  } catch (error) {
    return fromError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const actor = await requireApiCapability("ingress.manage");
    const body = ingressEndpointCreateSchema.parse(await request.json());
    const endpoint = await createIngressEndpoint({ ...body, actor, sourceIp: getSourceIpFromRequest(request) });
    return ok({ endpoint }, 201);
  } catch (error) {
    return fromError(error);
  }
}
