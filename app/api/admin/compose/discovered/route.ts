import { requireApiRole } from "@/server/auth/guards";
import { listDiscoveredComposeProjects } from "@/server/services/compose";
import { fromError, ok } from "@/server/http";

/** List Compose projects detected across nodes (with adoption status). */
export async function GET(): Promise<Response> {
  try {
    await requireApiRole("ADMIN");
    const projects = await listDiscoveredComposeProjects();
    return ok({ projects });
  } catch (error) {
    return fromError(error);
  }
}
