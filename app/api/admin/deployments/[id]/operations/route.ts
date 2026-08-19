import { requireApiRole } from "@/server/auth/guards";
import { listDeploymentOperations } from "@/server/services/deployment-executor";
import { cuidParamSchema } from "@/server/validation/admin";
import { fromError, ok } from "@/server/http";

/** List deployment operations (ADMIN). */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    await requireApiRole("ADMIN");
    const id = cuidParamSchema.parse((await params).id);
    const operations = await listDeploymentOperations(id);
    return ok({ data: operations, total: operations.length });
  } catch (error) {
    return fromError(error);
  }
}
