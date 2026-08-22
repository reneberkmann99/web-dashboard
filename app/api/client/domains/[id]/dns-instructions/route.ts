import { requireApiCapability } from "@/server/auth/guards";
import { fromError, ok } from "@/server/http";
import { dnsInstructionsForDomain } from "@/server/services/domains";
import { cuidParamSchema } from "@/server/validation/admin";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const actor = await requireApiCapability("domain.view");
    const id = cuidParamSchema.parse((await params).id);
    return ok({ instructions: await dnsInstructionsForDomain(id, actor) });
  } catch (error) {
    return fromError(error);
  }
}
