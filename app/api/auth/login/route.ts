import { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { logAuditEvent } from "@/server/audit";
import { createSession, setSessionCookie } from "@/server/auth/session";
import { verifyPassword } from "@/server/auth/password";
import { pamAuthenticate } from "@/server/auth/pam";
import { fromError, fail, ok } from "@/server/http";
import { loginSchema } from "@/server/validation/auth";

const LINUX_USERNAME_RE = /^[a-z_][a-z0-9_-]{1,31}$/;

function adminUsernames(): Set<string> {
  return new Set(
    (process.env.PAM_ADMIN_USERS ?? "rene")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * Find or create the "Linux Users" client account that auto-provisioned
 * PAM CLIENT accounts are attached to by default (so they land with zero
 * container access until an admin explicitly assigns containers).
 */
async function getOrCreateLinuxUsersClient() {
  const existing = await prisma.clientAccount.findUnique({ where: { slug: "linux-users" } });
  if (existing) {
    return existing;
  }
  return prisma.clientAccount.create({
    data: { name: "Linux Users", slug: "linux-users", isActive: true }
  });
}

/**
 * Authenticate against the host's PAM stack via the hostpanel-pam bridge.
 * On first successful auth for a given Linux username, auto-provisions a
 * User row (ADMIN if the username is in PAM_ADMIN_USERS, else CLIENT under
 * the auto-created "Linux Users" client account).
 */
async function authenticateViaPam(username: string, password: string, sourceIp: string | null) {
  const result = await pamAuthenticate(username, password);
  if (!result.ok) {
    await logAuditEvent({
      action: "LOGIN_FAILED",
      targetType: "USER",
      actorEmail: `pam:${username}`,
      metadata: { authSource: "PAM" },
      result: "FAILURE",
      sourceIp
    });
    return null;
  }

  let user = await prisma.user.findUnique({
    where: { pamUsername: username },
    include: { clientAccount: true }
  });

  if (!user) {
    const isAdmin = adminUsernames().has(username.toLowerCase());
    const clientAccount = isAdmin ? null : await getOrCreateLinuxUsersClient();

    user = await prisma.user.create({
      data: {
        email: `${username}@pam.local`,
        displayName: result.displayName ?? username,
        passwordHash: "PAM_MANAGED",
        authSource: "PAM",
        pamUsername: username,
        role: isAdmin ? "ADMIN" : "CLIENT",
        clientAccountId: clientAccount?.id ?? null,
        isActive: true
      },
      include: { clientAccount: true }
    });

    await logAuditEvent({
      actorUserId: user.id,
      actorEmail: user.email,
      actorRole: user.role,
      action: "USER_CREATE",
      targetType: "USER",
      targetId: user.id,
      metadata: { authSource: "PAM", pamUsername: username, autoProvisioned: true },
      result: "SUCCESS",
      sourceIp
    });
  } else if (!user.isActive) {
    return null;
  }

  return user;
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const body = loginSchema.parse(await request.json());
    const sourceIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
    const identifier = body.email.trim();

    const invalidCreds = fail("INVALID_CREDENTIALS", "Invalid email or password", 401);

    let user: Awaited<ReturnType<typeof prisma.user.findUnique>> & {
      clientAccount?: { id: string; isActive: boolean } | null;
    } | null = null;

    if (identifier.includes("@") && !identifier.endsWith("@pam.local")) {
      // Local (email + bcrypt hash) account path — unchanged behavior.
      const localUser = await prisma.user.findUnique({
        where: { email: identifier.toLowerCase() },
        include: { clientAccount: true }
      });

      if (!localUser || !localUser.isActive || localUser.authSource !== "LOCAL") {
        await logAuditEvent({
          action: "LOGIN_FAILED",
          targetType: "USER",
          targetId: localUser?.id ?? null,
          actorEmail: identifier,
          result: "FAILURE",
          sourceIp
        });
        return invalidCreds;
      }

      const passwordMatches = await verifyPassword(body.password, localUser.passwordHash);
      if (!passwordMatches) {
        await logAuditEvent({
          action: "LOGIN_FAILED",
          targetType: "USER",
          targetId: localUser.id,
          actorEmail: localUser.email,
          actorRole: localUser.role,
          result: "FAILURE",
          sourceIp
        });
        return invalidCreds;
      }

      user = localUser;
    } else if (LINUX_USERNAME_RE.test(identifier)) {
      // PAM path: identifier is a bare Linux username, not an email.
      user = await authenticateViaPam(identifier, body.password, sourceIp);
      if (!user) {
        return invalidCreds;
      }
    } else {
      await logAuditEvent({
        action: "LOGIN_FAILED",
        targetType: "USER",
        actorEmail: identifier,
        result: "FAILURE",
        sourceIp
      });
      return invalidCreds;
    }

    if (user.role === "CLIENT" && (!user.clientAccount || !user.clientAccount.isActive)) {
      await logAuditEvent({
        action: "LOGIN_FAILED",
        targetType: "USER",
        targetId: user.id,
        actorEmail: user.email,
        actorRole: user.role,
        metadata: { reason: "client_account_inactive" },
        result: "FAILURE",
        sourceIp
      });
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
      metadata: { authSource: user.authSource },
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
