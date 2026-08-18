import { requireApiRole } from "@/server/auth/guards";
import { listAllContainersForAdmin } from "@/server/services/containers";
import { fromError, ok } from "@/server/http";

export async function GET(): Promise<Response> {
  try {
    const session = await requireApiRole("ADMIN");

    const containers = await listAllContainersForAdmin();
    return ok({ containers });
  } catch (error) {
    return fromError(error);
  }
}
