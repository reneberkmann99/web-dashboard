import { requireApiRole } from "@/server/auth/guards";
import { fromError, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";
import { createDomain, listDomains } from "@/server/services/domains";
import { domainCreateSchema } from "@/server/validation/ingress";

/** ADMIN: every organization's domains. */
export async function GET(): Promise<Response> {
  try {
    const actor = await requireApiRole("ADMIN");
    return ok({ domains: await listDomains(actor) });
  } catch (error) {
    return fromError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const actor = await requireApiRole("ADMIN");
    const body = domainCreateSchema.parse(await request.json());
    const domain = await createDomain({ ...body, actor, sourceIp: getSourceIpFromRequest(request) });
    return ok({ domain }, 201);
  } catch (error) {
    return fromError(error);
  }
}
