import { requireApiRole } from "@/server/auth/guards";
import { getSourceIpFromRequest } from "@/server/request";
import { fromError, ok } from "@/server/http";
import { smtpTestEmailSchema } from "@/server/validation/admin";
import { sendSmtpTestEmail } from "@/server/services/mail";

/** Sends an actual, authenticated SMTP test email using the saved transport. */
export async function POST(request: Request): Promise<Response> {
  try {
    const session = await requireApiRole("ADMIN");
    const { to } = smtpTestEmailSchema.parse(await request.json());
    return ok(await sendSmtpTestEmail({ to, actor: session, sourceIp: getSourceIpFromRequest(request) }));
  } catch (error) {
    return fromError(error);
  }
}
