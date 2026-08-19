import { requireApiRole } from "@/server/auth/guards";
import { createSecret, listSecrets, SecretKeyUnavailableError } from "@/server/services/deployment-secrets";
import { createSecretSchema } from "@/server/validation/deployment";
import { cuidParamSchema } from "@/server/validation/admin";
import { fromError, fail, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";

/** List secret metadata (never values) for a managed deployment. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    await requireApiRole("ADMIN");
    const id = cuidParamSchema.parse((await params).id);
    const secrets = await listSecrets(id);
    return ok({ data: secrets, total: secrets.length });
  } catch (error) {
    return fromError(error);
  }
}

/** Create a secret (first version). Plaintext is never returned. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const session = await requireApiRole("ADMIN");
    const sourceIp = getSourceIpFromRequest(request);
    const deploymentId = cuidParamSchema.parse((await params).id);
    const body = createSecretSchema.parse(await request.json());

    const secret = await createSecret({
      deploymentId,
      key: body.key,
      value: body.value,
      actor: session,
      sourceIp
    });
    return ok(secret, 201);
  } catch (error) {
    if (error instanceof SecretKeyUnavailableError) {
      return fail("SECRET_KEY_UNAVAILABLE", "Deployment secrets encryption key is not configured", 500);
    }
    return fromError(error);
  }
}
