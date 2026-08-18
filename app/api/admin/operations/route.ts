import { requireApiRole } from "@/server/auth/guards";
import { listOperationsForSession } from "@/server/services/operations";
import { fromError, ok } from "@/server/http";

export async function GET(request: Request): Promise<Response> {
  try {
    const session = await requireApiRole("ADMIN");
    const limit = Number(new URL(request.url).searchParams.get("limit") ?? "50");
    const operations = await listOperationsForSession(session, limit);
    return ok({ operations });
  } catch (error) {
    return fromError(error);
  }
}
