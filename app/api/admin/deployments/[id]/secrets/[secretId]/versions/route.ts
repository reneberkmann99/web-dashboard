import { requireApiRole } from "@/server/auth/guards";
import { rotateSecret, SecretKeyUnavailableError } from "@/server/services/deployment-secrets";
import { rotateSecretSchema } from "@/server/validation/deployment";
import { cuidParamSchema } from "@/server/validation/admin";
import { fromError, fail, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";

/** Rotate a secret by appending a new version. Plaintext is never returned. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; secretId: string }> }
): Promise<Response> {
  try {
    const session = await requireApiRole("ADMIN");
    const sourceIp = getSourceIpFromRequest(request);
    const { id, secretId } = await params;
    const deploymentId = cuidParamSchema.parse(id);
    const sid = cuidParamSchema.parse(secretId);
    const body = rotateSecretSchema.parse(await request.json());

    const result = await rotateSecret({
      deploymentId,
      secretId: sid,
      value: body.value,
      actor: session,
      sourceIp
    });
    return ok(result, 201);
  } catch (error) {
    if (error instanceof SecretKeyUnavailableError) {
      return fail("SECRET_KEY_UNAVAILABLE", "Deployment secrets encryption key is not configured", 500);
    }
    return fromError(error);
  }
}
