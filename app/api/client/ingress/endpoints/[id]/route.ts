import { requireApiCapability } from "@/server/auth/guards";
import { fromError, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";
import { deleteIngressEndpoint, getIngressEndpoint, updateIngressEndpoint } from "@/server/services/ingress";
import { cuidParamSchema } from "@/server/validation/admin";
import { ingressEndpointUpdateSchema } from "@/server/validation/ingress";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const actor = await requireApiCapability("ingress.view");
    const id = cuidParamSchema.parse((await params).id);
    return ok({ endpoint: await getIngressEndpoint(id, actor) });
  } catch (error) {
    return fromError(error);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const actor = await requireApiCapability("ingress.manage");
    const id = cuidParamSchema.parse((await params).id);
    const body = ingressEndpointUpdateSchema.parse(await request.json());
    const endpoint = await updateIngressEndpoint({ id, ...body, actor, sourceIp: getSourceIpFromRequest(request) });
    return ok({ endpoint });
  } catch (error) {
    return fromError(error);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const actor = await requireApiCapability("ingress.manage");
    const id = cuidParamSchema.parse((await params).id);
    await deleteIngressEndpoint({ id, actor, sourceIp: getSourceIpFromRequest(request) });
    return ok({ success: true });
  } catch (error) {
    return fromError(error);
  }
}
