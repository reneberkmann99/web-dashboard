import crypto from "node:crypto";
import { requireApiRole } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { createUserSchema } from "@/server/validation/admin";
import { fromError, fail, ok } from "@/server/http";
import { logAuditEvent } from "@/server/audit";
import { getSourceIpFromRequest } from "@/server/request";
import { sendInvitationEmail } from "@/server/services/mail";

const ACTIVATION_TTL_HOURS = 72;

export async function GET(): Promise<Response> {
  try {
    await requireApiRole("ADMIN");

    const [users, clients] = await Promise.all([
      prisma.user.findMany({
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          email: true,
          displayName: true,
          role: true,
          isActive: true,
          lastLoginAt: true,
          authSource: true,
          createdAt: true,
          clientAccountId: true,
          clientAccount: { select: { id: true, name: true } },
          activationToken: { select: { createdAt: true, expiresAt: true, usedAt: true } }
        }
      }),
      prisma.clientAccount.findMany({
        where: { isActive: true },
        orderBy: { name: "asc" },
        select: { id: true, name: true }
      })
    ]);

    // `pending` distinguishes "invited, not yet activated" from "deactivated".
    const usersWithState = users.map(({ activationToken, ...rest }) => ({
      ...rest,
      pending: !rest.isActive && activationToken?.usedAt == null
    }));

    return ok({ users: usersWithState, clients });
  } catch (error) {
    return fromError(error);
  }
}

/**
 * Create a PENDING user. No password is ever set or displayed by the admin:
 * a one-time activation token is generated and the admin copies the
 * activation URL to hand to the user.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const session = await requireApiRole("ADMIN");
    const sourceIp = getSourceIpFromRequest(request);

    const body = createUserSchema.parse(await request.json());

    if (body.role !== "ADMIN" && !body.clientAccountId) {
      return fail("VALIDATION_ERROR", "A client role requires a client account", 400);
    }

    const clientAccountId = body.role === "ADMIN" ? null : body.clientAccountId ?? null;

    const created = await prisma.user.create({
      data: {
        email: body.email.toLowerCase(),
        displayName: body.displayName,
        passwordHash: null, // pending — user sets it during activation
        role: body.role,
        isActive: false, // pending until activation
        clientAccountId
      }
    });

    const rawToken = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + ACTIVATION_TTL_HOURS * 60 * 60 * 1000);
    await prisma.activationToken.create({
      data: {
        userId: created.id,
        tokenHash: crypto.createHash("sha256").update(rawToken).digest("hex"),
        expiresAt
      }
    });

    await logAuditEvent({
      actorUserId: session.userId,
      actorEmail: session.email,
      actorRole: session.role,
      action: "USER_CREATE",
      targetType: "USER",
      targetId: created.id,
      metadata: {
        createdRole: created.role,
        createdEmail: created.email,
        activationExpiresAt: expiresAt.toISOString()
      },
      result: "SUCCESS",
      sourceIp
    });

    const activationUrl = `/activate?token=${rawToken}`;
    const emailDelivery = await sendInvitationEmail({
      to: created.email,
      displayName: created.displayName,
      activationUrl,
      activationExpiresAt: expiresAt.toISOString()
    });

    // The manual activation URL is always returned even if delivery is off or
    // the SMTP server rejects a message.
    return ok(
      {
        id: created.id,
        activationUrl,
        activationExpiresAt: expiresAt.toISOString(),
        emailDelivery
      },
      201
    );
  } catch (error) {
    return fromError(error);
  }
}
