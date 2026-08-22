import { requireApiCapability } from "@/server/auth/guards";
import { fromError, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";
import { createDomain, listDomains } from "@/server/services/domains";
import { domainCreateSchema } from "@/server/validation/ingress";

/** Organization: own domains only (server/services/domains.ts is the sole scope-enforcement point). */
export async function GET(): Promise<Response> {
  try {
    const actor = await requireApiCapability("domain.view");
    return ok({ domains: await listDomains(actor) });
  } catch (error) {
    return fromError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const actor = await requireApiCapability("domain.manage");
    const body = domainCreateSchema.parse(await request.json());
    const domain = await createDomain({ ...body, actor, sourceIp: getSourceIpFromRequest(request) });
    return ok({ domain }, 201);
  } catch (error) {
    return fromError(error);
  }
}
