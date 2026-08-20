import { requireApiRole } from "@/server/auth/guards";
import { fromError, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";
import { createAttentionSilence, listAttentionSilences } from "@/server/services/attention-lifecycle";
import { silenceSchema } from "@/server/validation/attention-lifecycle";

export async function GET(): Promise<Response> {
  try {
    await requireApiRole("ADMIN");
    return ok({ silences: await listAttentionSilences() });
  } catch (error) {
    return fromError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const actor = await requireApiRole("ADMIN");
    const body = silenceSchema.parse(await request.json());
    const silence = await createAttentionSilence({
      ...body,
      actor,
      sourceIp: getSourceIpFromRequest(request)
    });
    return ok({ silence }, 201);
  } catch (error) {
    return fromError(error);
  }
}
