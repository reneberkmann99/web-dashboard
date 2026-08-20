import { requireApiCapability } from "@/server/auth/guards";
import { dismissRecentFailure, dismissAllRecentFailures } from "@/server/services/attention";
import { fromError, ok } from "@/server/http";
import { z } from "zod";

const bodySchema = z.union([
  z.object({ key: z.string().min(1).max(200) }),
  z.object({ all: z.literal(true) })
]);

/**
 * Dismiss one or all Recent Failures from the Overview feed. UI-only: never
 * deletes audit/activity history, mutates an operation, or resolves an active
 * attention condition.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const session = await requireApiCapability("platform.admin");
    const body = bodySchema.parse(await request.json().catch(() => ({})));

    if ("all" in body) {
      const count = await dismissAllRecentFailures(session.email);
      return ok({ dismissed: count });
    }
    await dismissRecentFailure(body.key, session.email);
    return ok({ dismissed: 1 });
  } catch (error) {
    return fromError(error);
  }
}
