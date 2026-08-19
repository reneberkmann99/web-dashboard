import { requireApiRole } from "@/server/auth/guards";
import { setSecretActive, listSecretVersions, SecretKeyUnavailableError } from "@/server/services/deployment-secrets";
import { patchSecretSchema } from "@/server/validation/deployment";
import { cuidParamSchema } from "@/server/validation/admin";
import { fromError, fail, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";

/** Version metadata history for one secret (ADMIN). Never ciphertext. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; secretId: string }> }
): Promise<Response> {
  try {
    await requireApiRole("ADMIN");
    const { id, secretId } = await params;
    const deploymentId = cuidParamSchema.parse(id);
    const sid = cuidParamSchema.parse(secretId);
    const versions = await listSecretVersions(deploymentId, sid);
    if (!versions) return fail("NOT_FOUND", "Secret not found", 404);
    return ok({ data: versions, total: versions.length });
  } catch (error) {
    return fromError(error);
  }
}

/** Soft-disable (or re-enable) a secret. Never deletes version history. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; secretId: string }> }
): Promise<Response> {
  try {
    const session = await requireApiRole("ADMIN");
    const sourceIp = getSourceIpFromRequest(request);
    const { id, secretId } = await params;
    const deploymentId = cuidParamSchema.parse(id);
    const sid = cuidParamSchema.parse(secretId);
    const body = patchSecretSchema.parse(await request.json());

    const secret = await setSecretActive({
      deploymentId,
      secretId: sid,
      isActive: body.isActive,
      actor: session,
      sourceIp
    });
    return ok(secret);
  } catch (error) {
    if (error instanceof SecretKeyUnavailableError) {
      return fail("SECRET_KEY_UNAVAILABLE", "Deployment secrets encryption key is not configured", 500);
    }
    return fromError(error);
  }
}
