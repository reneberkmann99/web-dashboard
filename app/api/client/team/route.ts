import { requireApiCapability } from "@/server/auth/guards";
import {
  listTeamUsers,
  inviteTeamUser,
  ClientTeamForbiddenError
} from "@/server/services/client-team";
import { inviteClientUserSchema } from "@/server/validation/admin";
import { fromError, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";

/** CLIENT_ADMIN: list own client's users. */
export async function GET(): Promise<Response> {
  try {
    const session = await requireApiCapability("user.manage");
    const users = await listTeamUsers(session);
    return ok({ users });
  } catch (error) {
    return fromError(error);
  }
}

/** CLIENT_ADMIN: invite a new operator/viewer to the caller's own client. */
export async function POST(request: Request): Promise<Response> {
  try {
    const session = await requireApiCapability("user.manage");
    const sourceIp = getSourceIpFromRequest(request);
    const body = inviteClientUserSchema.parse(await request.json());

    const result = await inviteTeamUser(
      session,
      { email: body.email, displayName: body.displayName, role: body.role },
      sourceIp
    );
    return ok(result, 201);
  } catch (error) {
    if (error instanceof ClientTeamForbiddenError) {
      return fromError(new Error("FORBIDDEN"));
    }
    return fromError(error);
  }
}
