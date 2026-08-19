import { requireApiCapability } from "@/server/auth/guards";
import { rotateSecret, SecretKeyUnavailableError } from "@/server/services/deployment-secrets";
import { requireClientDeployment } from "@/server/services/client-deployments";
import { rotateSecretSchema } from "@/server/validation/deployment";
import { fail, fromError, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; secretId: string }> }
): Promise<Response> {
  try {
    const session = await requireApiCapability("deployment.manage");
    const sourceIp = getSourceIpFromRequest(request);
    const { id, secretId } = await params;
    await requireClientDeployment(session, id, "deployment.manage");
    const body = rotateSecretSchema.parse(await request.json());

    const version = await rotateSecret({ deploymentId: id, secretId, value: body.value, actor: session, sourceIp });
    return ok(version, 201);
  } catch (error) {
    if (error instanceof SecretKeyUnavailableError) {
      return fail("SECRET_KEY_UNAVAILABLE", "Deployment secrets encryption key is not configured", 500);
    }
    return fromError(error);
  }
}
