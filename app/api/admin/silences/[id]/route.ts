import { requireApiRole } from "@/server/auth/guards";
import { fromError, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";
import { cancelAttentionSilence } from "@/server/services/attention-lifecycle";
import { cuidParamSchema } from "@/server/validation/admin";

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const actor = await requireApiRole("ADMIN");
    const silence = await cancelAttentionSilence({
      silenceId: cuidParamSchema.parse((await params).id),
      actor,
      sourceIp: getSourceIpFromRequest(request)
    });
    return ok({ silence });
  } catch (error) {
    return fromError(error);
  }
}
