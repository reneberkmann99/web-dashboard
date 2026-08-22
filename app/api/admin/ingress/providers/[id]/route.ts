import { requireApiRole } from "@/server/auth/guards";
import { fromError, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";
import { deleteIngressProvider, updateIngressProvider } from "@/server/services/ingress";
import { cuidParamSchema } from "@/server/validation/admin";
import { ingressProviderUpdateSchema } from "@/server/validation/ingress";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const actor = await requireApiRole("ADMIN");
    const id = cuidParamSchema.parse((await params).id);
    const body = ingressProviderUpdateSchema.parse(await request.json());
    const provider = await updateIngressProvider({ id, ...body, actor, sourceIp: getSourceIpFromRequest(request) });
    return ok({ provider });
  } catch (error) {
    return fromError(error);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const actor = await requireApiRole("ADMIN");
    const id = cuidParamSchema.parse((await params).id);
    await deleteIngressProvider({ id, actor, sourceIp: getSourceIpFromRequest(request) });
    return ok({ success: true });
  } catch (error) {
    return fromError(error);
  }
}
