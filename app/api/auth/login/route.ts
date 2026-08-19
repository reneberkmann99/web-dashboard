import { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { logAuditEvent } from "@/server/audit";
import { createSession, setSessionCookie, setCsrfCookie } from "@/server/auth/session";
import { verifyPassword } from "@/server/auth/password";
import { pamAuthenticate } from "@/server/auth/pam";
import { fromError, fail, ok } from "@/server/http";
import { loginSchema } from "@/server/validation/auth";
import { isClientRole } from "@/types/domain";

const LINUX_USERNAME_RE = /^[a-z_][a-z0-9_-]{1,31}$/;

/**
 * Brute-force protection: fixed-window rate limiter keyed by
 * (source-ip + identifier). In-memory is acceptable for a single-instance
 * control plane; documented in ARCHITECTURE.md.
 */
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function loginRateLimited(ip: string, identifier: string): boolean {
  const key = `${ip}|${identifier.toLowerCase()}`;
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || entry.resetAt < now) {
    loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > LOGIN_MAX_ATTEMPTS;
}

function adminUsernames(): Set<string> {
  return new Set(
    (process.env.PAM_ADMIN_USERS ?? "rene")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

async function getOrCreateLinuxUsersClient() {
  const existing = await prisma.clientAccount.findUnique({ where: { slug: "linux-users" } });
  if (existing) {
    return existing;
  }
  return prisma.clientAccount.create({
    data: { name: "Linux Users", slug: "linux-users", isActive: true }
  });
}

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
        role: isAdmin ? "ADMIN" : "CLIENT_OPERATOR",
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
    const sourceIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const identifier = body.email.trim();

    const invalidCreds = fail("INVALID_CREDENTIALS", "Invalid email or password", 401);

    if (loginRateLimited(sourceIp, identifier)) {
      await logAuditEvent({
        action: "LOGIN_RATE_LIMITED",
        targetType: "USER",
        actorEmail: identifier,
        result: "FAILURE",
        sourceIp
      });
      return fail("RATE_LIMITED", "Too many login attempts. Try again later.", 429);
    }

    let user:
      | (Awaited<ReturnType<typeof prisma.user.findUnique>> & {
          clientAccount?: { id: string; isActive: boolean } | null;
        })
      | null = null;

    if (identifier.includes("@") && !identifier.endsWith("@pam.local")) {
      const localUser = await prisma.user.findUnique({
        where: { email: identifier.toLowerCase() },
        include: { clientAccount: true }
      });

      if (!localUser || localUser.authSource !== "LOCAL") {
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

      // Pending accounts (no password set yet) cannot log in — must activate first.
      if (!localUser.passwordHash) {
        await logAuditEvent({
          action: "LOGIN_FAILED",
          targetType: "USER",
          targetId: localUser.id,
          actorEmail: localUser.email,
          metadata: { reason: "pending_activation" },
          result: "FAILURE",
          sourceIp
        });
        return fail("ACCOUNT_PENDING", "Account is pending activation. Check your activation link.", 403);
      }

      if (!localUser.isActive) {
        await logAuditEvent({
          action: "LOGIN_FAILED",
          targetType: "USER",
          targetId: localUser.id,
          actorEmail: localUser.email,
          metadata: { reason: "disabled" },
          result: "FAILURE",
          sourceIp
        });
        return fail("ACCOUNT_DISABLED", "Account is disabled", 403);
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

    if (isClientRole(user.role) && (!user.clientAccount || !user.clientAccount.isActive)) {
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
    setCsrfCookie(response, session.expiresAt);
    return response;
  } catch (error) {
    return fromError(error);
  }
}
