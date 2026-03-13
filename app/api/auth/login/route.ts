import { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { logAuditEvent } from "@/server/audit";
import { createSession, setSessionCookie } from "@/server/auth/session";
import { verifyPassword } from "@/server/auth/password";
import { fromError, fail, ok } from "@/server/http";
import { loginSchema } from "@/server/validation/auth";

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const body = loginSchema.parse(await request.json());
    const sourceIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

    const user = await prisma.user.findUnique({
      where: { email: body.email.toLowerCase() },
      include: {
        clientAccount: true
      }
    });

    const invalidCreds = fail("INVALID_CREDENTIALS", "Invalid email or password", 401);

    if (!user || !user.isActive) {
      await logAuditEvent({
        action: "LOGIN_FAILED",
        targetType: "USER",
        targetId: user?.id ?? null,
        actorEmail: body.email,
        result: "FAILURE",
        sourceIp
      });
      return invalidCreds;
    }

    const passwordMatches = await verifyPassword(body.password, user.passwordHash);
    if (!passwordMatches) {
      await logAuditEvent({
        action: "LOGIN_FAILED",
        targetType: "USER",
        targetId: user.id,
        actorEmail: body.email,
        actorRole: user.role,
        result: "FAILURE",
        sourceIp
      });
      return invalidCreds;
    }

    if (user.role === "CLIENT" && (!user.clientAccount || !user.clientAccount.isActive)) {
      return fail("CLIENT_INACTIVE", "Client account is inactive", 403);
    }

    const session = await createSession(user.id);

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() }
    });

    await logAuditEvent({
      actorUserId: user.id,
      actorEmail: user.email,
      actorRole: user.role,
      action: "LOGIN_SUCCESS",
      targetType: "USER",
      targetId: user.id,
      result: "SUCCESS",
      sourceIp
    });

    const response = ok({
      user: {
        id: user.id,
        email: user.email,
        role: user.role
      },
      redirectPath: user.role === "ADMIN" ? "/admin" : "/client"
    });

    setSessionCookie(response, session.token, session.expiresAt);
    return response;
  } catch (error) {
    return fromError(error);
  }
}
