import { requireApiRole } from "@/server/auth/guards";
import { fromError, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";
import { acknowledgeAttention, unacknowledgeAttention } from "@/server/services/attention-lifecycle";
import { cuidParamSchema } from "@/server/validation/admin";
import { acknowledgementSchema } from "@/server/validation/attention-lifecycle";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const actor = await requireApiRole("ADMIN");
    const attentionStateId = cuidParamSchema.parse((await params).id);
    const body = acknowledgementSchema.parse(await request.json());
    const acknowledgement = await acknowledgeAttention({
      attentionStateId,
      actor,
      note: body.note,
      sourceIp: getSourceIpFromRequest(request)
    });
    return ok({ acknowledgement });
  } catch (error) {
    return fromError(error);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const actor = await requireApiRole("ADMIN");
    const attentionStateId = cuidParamSchema.parse((await params).id);
    const acknowledgement = await unacknowledgeAttention({
      attentionStateId,
      actor,
      sourceIp: getSourceIpFromRequest(request)
    });
    return ok({ acknowledgement });
  } catch (error) {
    return fromError(error);
  }
}
