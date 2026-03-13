import { getCurrentSession } from "@/server/auth/session";
import { fail, ok } from "@/server/http";

export async function GET(): Promise<Response> {
  const session = await getCurrentSession();
  if (!session) {
    return fail("UNAUTHORIZED", "Authentication required", 401);
  }

  return ok({
    user: {
      id: session.userId,
      email: session.email,
      displayName: session.displayName,
      role: session.role,
      clientAccountId: session.clientAccountId,
      clientAccountName: session.clientAccountName
    }
  });
}
