import { requireApiRole } from "@/server/auth/guards";
import { getSourceIpFromRequest } from "@/server/request";
import { fromError, ok } from "@/server/http";
import { updatePlatformEmailSettingsSchema } from "@/server/validation/admin";
import { getPlatformEmailSettings, updatePlatformEmailSettings } from "@/server/services/mail";

/** Platform-admin SMTP settings. This endpoint never returns a password or ciphertext. */
export async function GET(): Promise<Response> {
  try {
    await requireApiRole("ADMIN");
    return ok(await getPlatformEmailSettings());
  } catch (error) {
    return fromError(error);
  }
}

export async function PATCH(request: Request): Promise<Response> {
  try {
    const session = await requireApiRole("ADMIN");
    const settings = updatePlatformEmailSettingsSchema.parse(await request.json());
    const result = await updatePlatformEmailSettings({
      settings,
      actor: session,
      sourceIp: getSourceIpFromRequest(request)
    });
    return ok(result);
  } catch (error) {
    return fromError(error);
  }
}
