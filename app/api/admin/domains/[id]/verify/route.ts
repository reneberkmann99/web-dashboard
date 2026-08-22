import { requireApiRole } from "@/server/auth/guards";
import { fromError, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";
import { verifyDomain } from "@/server/services/domains";
import { cuidParamSchema } from "@/server/validation/admin";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const actor = await requireApiRole("ADMIN");
    const id = cuidParamSchema.parse((await params).id);
    const domain = await verifyDomain({ id, actor, sourceIp: getSourceIpFromRequest(request) });
    return ok({ domain });
  } catch (error) {
    return fromError(error);
  }
}
