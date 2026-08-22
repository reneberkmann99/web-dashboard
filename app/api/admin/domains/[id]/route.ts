import { z } from "zod";
import { requireApiRole } from "@/server/auth/guards";
import { fromError, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";
import { deleteDomain, getDomain, setDomainEnabled } from "@/server/services/domains";
import { cuidParamSchema } from "@/server/validation/admin";

const patchSchema = z.object({ enabled: z.boolean() }).strict();

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const actor = await requireApiRole("ADMIN");
    const id = cuidParamSchema.parse((await params).id);
    return ok({ domain: await getDomain(id, actor) });
  } catch (error) {
    return fromError(error);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const actor = await requireApiRole("ADMIN");
    const id = cuidParamSchema.parse((await params).id);
    const body = patchSchema.parse(await request.json());
    const domain = await setDomainEnabled({ id, enabled: body.enabled, actor, sourceIp: getSourceIpFromRequest(request) });
    return ok({ domain });
  } catch (error) {
    return fromError(error);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const actor = await requireApiRole("ADMIN");
    const id = cuidParamSchema.parse((await params).id);
    await deleteDomain({ id, actor, sourceIp: getSourceIpFromRequest(request) });
    return ok({ success: true });
  } catch (error) {
    return fromError(error);
  }
}
