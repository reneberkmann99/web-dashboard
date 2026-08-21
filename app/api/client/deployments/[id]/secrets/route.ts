import { requireApiCapability } from "@/server/auth/guards";
import { createSecret, listSecrets, SecretKeyUnavailableError } from "@/server/services/deployment-secrets";
import { requireClientDeployment } from "@/server/services/client-deployments";
import { createSecretSchema } from "@/server/validation/deployment";
import { fail, fromError, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const session = await requireApiCapability("secrets.manage");
    const { id } = await params;
    await requireClientDeployment(session, id, "secrets.manage");
    const secrets = await listSecrets(id);
    return ok({ data: secrets, total: secrets.length });
  } catch (error) {
    return fromError(error);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const session = await requireApiCapability("deployment.manage");
    const sourceIp = getSourceIpFromRequest(request);
    const { id } = await params;
    await requireClientDeployment(session, id, "deployment.manage");
    const body = createSecretSchema.parse(await request.json());

    const secret = await createSecret({ deploymentId: id, key: body.key, value: body.value, actor: session, sourceIp });
    return ok(secret, 201);
  } catch (error) {
    if (error instanceof SecretKeyUnavailableError) {
      return fail("SECRET_KEY_UNAVAILABLE", "Deployment secrets encryption key is not configured", 500);
    }
    return fromError(error);
  }
}
