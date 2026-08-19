import { requireApiCapability } from "@/server/auth/guards";
import { listSecretVersions, SecretKeyUnavailableError } from "@/server/services/deployment-secrets";
import { requireClientDeployment } from "@/server/services/client-deployments";
import { fail, fromError, ok } from "@/server/http";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; secretId: string }> }
): Promise<Response> {
  try {
    const session = await requireApiCapability("deployment.view");
    const { id, secretId } = await params;
    await requireClientDeployment(session, id, "deployment.view");
    const versions = await listSecretVersions(id, secretId);
    if (!versions) return fail("NOT_FOUND", "Secret not found", 404);
    return ok({ data: versions, total: versions.length });
  } catch (error) {
    if (error instanceof SecretKeyUnavailableError) {
      return fail("SECRET_KEY_UNAVAILABLE", "Deployment secrets encryption key is not configured", 500);
    }
    return fromError(error);
  }
}
