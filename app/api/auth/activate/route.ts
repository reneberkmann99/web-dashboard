import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { hashPassword } from "@/server/auth/password";
import { createSession, setSessionCookie, setCsrfCookie } from "@/server/auth/session";
import { logAuditEvent } from "@/server/audit";
import { fail, ok } from "@/server/http";
import { activateAccountSchema } from "@/server/validation/admin";
import { getSourceIpFromRequest } from "@/server/request";

/**
 * One-time account activation: the user redeems the token they received via
 * the admin-copied activation URL and sets their own password. The token is
 * single-use, expires, and the account becomes active on success.
 */
export async function POST(request: NextRequest): Promise<Response> {
  try {
    const body = activateAccountSchema.parse(await request.json());
    const sourceIp = getSourceIpFromRequest(request);

    const tokenHash = crypto.createHash("sha256").update(body.token).digest("hex");

    const token = await prisma.activationToken.findUnique({
      where: { tokenHash },
      include: { user: true }
    });

    if (!token || token.usedAt || token.expiresAt.getTime() < Date.now()) {
      await logAuditEvent({
        action: "ACCOUNT_ACTIVATE_FAILED",
        targetType: "ACTIVATION_TOKEN",
        metadata: { reason: token ? (token.usedAt ? "already_used" : "expired") : "not_found" },
        result: "FAILURE",
        sourceIp
      });
      return fail("INVALID_TOKEN", "Activation link is invalid, already used, or expired", 400);
    }

    if (token.user.isActive) {
      return fail("INVALID_TOKEN", "This account is already active", 400);
    }

    await prisma.$transaction([
      prisma.user.update({
        where: { id: token.userId },
        data: { passwordHash: await hashPassword(body.password), isActive: true }
      }),
      prisma.activationToken.update({
        where: { id: token.id },
        data: { usedAt: new Date() }
      })
    ]);

    await logAuditEvent({
      actorUserId: token.userId,
      actorEmail: token.user.email,
      actorRole: token.user.role,
      action: "ACCOUNT_ACTIVATED",
      targetType: "USER",
      targetId: token.userId,
      result: "SUCCESS",
      sourceIp
    });

    // Log the user in immediately after activation.
    const session = await createSession(token.userId);
    const response = ok({
      user: { id: token.user.id, email: token.user.email, role: token.user.role },
      redirectPath: token.user.role === "ADMIN" ? "/admin" : "/client"
    });
    setSessionCookie(response, session.token, session.expiresAt);
    setCsrfCookie(response);
    return response;
  } catch (error) {
    const { fromError } = await import("@/server/http");
    return fromError(error);
  }
}
