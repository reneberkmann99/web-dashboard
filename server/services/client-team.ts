import crypto from "node:crypto";
import { AuthSource, Role } from "@prisma/client";
import { prisma } from "@/server/db";
import { logAuditEvent } from "@/server/audit";
import type { AuthSession } from "@/server/auth/session";

/**
 * Client-side (CLIENT_ADMIN) team management.
 *
 * A CLIENT_ADMIN can manage the users of *their own* client account only:
 *  - list users
 *  - invite operators / viewers (never admins, never client-admins)
 *  - reissue a pending invitation
 *  - deactivate/reactivate operators / viewers (never themselves, never
 *    client-admins, never platform admins)
 *
 * Every query is hard-scoped to `session.clientAccountId`; there is no code
 * path that can read or mutate another client's users. ADMIN users are managed
 * exclusively through `/api/admin/users`.
 */

const ACTIVATION_TTL_HOURS = 72;

/** Roles a CLIENT_ADMIN may assign. Deliberately excludes ADMIN and CLIENT_ADMIN. */
export const CLIENT_INVITABLE_ROLES = [Role.CLIENT_OPERATOR, Role.CLIENT_VIEWER] as const;
export type ClientInvitableRole = (typeof CLIENT_INVITABLE_ROLES)[number];

export class ClientTeamForbiddenError extends Error {
  constructor() {
    super("FORBIDDEN");
    this.name = "ClientTeamForbiddenError";
  }
}

function assertClientAdmin(session: AuthSession): string {
  if (session.role !== Role.CLIENT_ADMIN || !session.clientAccountId) {
    throw new ClientTeamForbiddenError();
  }
  return session.clientAccountId;
}

export type ClientTeamUser = {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  isActive: boolean;
  lastLoginAt: Date | null;
  authSource: AuthSource;
  /** True while the account is pending (unused activation token). */
  pending: boolean;
};

export async function listTeamUsers(session: AuthSession): Promise<ClientTeamUser[]> {
  const clientId = assertClientAdmin(session);

  const users = await prisma.user.findMany({
    where: { clientAccountId: clientId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      email: true,
      displayName: true,
      role: true,
      isActive: true,
      lastLoginAt: true,
      authSource: true,
      activationToken: { select: { usedAt: true, expiresAt: true } }
    }
  });

  return users.map((u) => ({
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    role: u.role,
    isActive: u.isActive,
    lastLoginAt: u.lastLoginAt,
    authSource: u.authSource,
    pending: !u.isActive && u.activationToken?.usedAt == null
  }));
}

function newActivationToken(): { rawToken: string; expiresAt: Date } {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + ACTIVATION_TTL_HOURS * 60 * 60 * 1000);
  return { rawToken, expiresAt };
}

export async function inviteTeamUser(
  session: AuthSession,
  input: { email: string; displayName: string; role: ClientInvitableRole },
  sourceIp: string | null
): Promise<{ id: string; activationUrl: string; activationExpiresAt: string }> {
  const clientId = assertClientAdmin(session);
  if (!CLIENT_INVITABLE_ROLES.includes(input.role)) {
    throw new ClientTeamForbiddenError();
  }

  const created = await prisma.user.create({
    data: {
      email: input.email.toLowerCase(),
      displayName: input.displayName,
      passwordHash: null, // pending — the user sets it during activation
      role: input.role,
      isActive: false,
      clientAccountId: clientId
    }
  });

  const { rawToken, expiresAt } = newActivationToken();
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
    clientAccountId: clientId,
    action: "USER_CREATE",
    targetType: "USER",
    targetId: created.id,
    metadata: { createdRole: created.role, createdEmail: created.email, invitedBy: "CLIENT_ADMIN" },
    result: "SUCCESS",
    sourceIp
  });

  return {
    id: created.id,
    activationUrl: `/activate?token=${rawToken}`,
    activationExpiresAt: expiresAt.toISOString()
  };
}

/** Regenerate the activation token for a still-pending user of the same client. */
export async function reissueInvite(
  session: AuthSession,
  userId: string,
  sourceIp: string | null
): Promise<{ activationUrl: string; activationExpiresAt: string; recipient: { email: string; displayName: string } } | null> {
  const clientId = assertClientAdmin(session);

  const target = await prisma.user.findFirst({
    where: { id: userId, clientAccountId: clientId },
    select: { id: true, isActive: true, role: true, email: true, displayName: true }
  });
  if (!target || target.isActive) {
    return null;
  }

  const { rawToken, expiresAt } = newActivationToken();
  await prisma.activationToken.upsert({
    where: { userId: target.id },
    update: {
      tokenHash: crypto.createHash("sha256").update(rawToken).digest("hex"),
      expiresAt,
      usedAt: null
    },
    create: {
      userId: target.id,
      tokenHash: crypto.createHash("sha256").update(rawToken).digest("hex"),
      expiresAt
    }
  });

  await logAuditEvent({
    actorUserId: session.userId,
    actorEmail: session.email,
    actorRole: session.role,
    clientAccountId: clientId,
    action: "USER_REINVITE",
    targetType: "USER",
    targetId: target.id,
    result: "SUCCESS",
    sourceIp
  });

  return {
    activationUrl: `/activate?token=${rawToken}`,
    activationExpiresAt: expiresAt.toISOString(),
    recipient: { email: target.email, displayName: target.displayName }
  };
}

/** Deactivate (or reactivate) an operator/viewer of the same client. */
export async function setTeamUserActive(
  session: AuthSession,
  userId: string,
  isActive: boolean,
  sourceIp: string | null
): Promise<boolean> {
  const clientId = assertClientAdmin(session);

  const target = await prisma.user.findFirst({
    where: { id: userId, clientAccountId: clientId },
    select: { id: true, role: true, authSource: true }
  });
  if (!target) {
    return false;
  }

  // A CLIENT_ADMIN may not deactivate themselves, another CLIENT_ADMIN, or a
  // platform admin. PAM users are managed by the platform, not the client.
  if (
    target.id === session.userId ||
    target.role === Role.CLIENT_ADMIN ||
    target.role === Role.ADMIN ||
    target.authSource === AuthSource.PAM
  ) {
    return false;
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: target.id }, data: { isActive } });
    if (!isActive) await tx.session.deleteMany({ where: { userId: target.id } });
  });

  await logAuditEvent({
    actorUserId: session.userId,
    actorEmail: session.email,
    actorRole: session.role,
    clientAccountId: clientId,
    action: isActive ? "USER_ACTIVATE" : "USER_DEACTIVATE",
    targetType: "USER",
    targetId: target.id,
    metadata: { targetRole: target.role },
    result: "SUCCESS",
    sourceIp
  });

  return true;
}

/** Change the organization role of an operator/viewer in the caller's own organization. */
export async function setTeamUserRole(
  session: AuthSession,
  userId: string,
  role: ClientInvitableRole,
  sourceIp: string | null
): Promise<boolean> {
  const clientId = assertClientAdmin(session);
  if (!CLIENT_INVITABLE_ROLES.includes(role)) throw new ClientTeamForbiddenError();

  const target = await prisma.user.findFirst({
    where: { id: userId, clientAccountId: clientId },
    select: { id: true, role: true, authSource: true }
  });
  if (!target || target.role === Role.ADMIN || target.role === Role.CLIENT_ADMIN || target.authSource === AuthSource.PAM) {
    return false;
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: target.id }, data: { role } });
    // A changed role must take effect immediately, not after a 12h session TTL.
    await tx.session.deleteMany({ where: { userId: target.id } });
  });

  await logAuditEvent({
    actorUserId: session.userId,
    actorEmail: session.email,
    actorRole: session.role,
    clientAccountId: clientId,
    action: "MEMBERSHIP_ROLE_CHANGED",
    targetType: "USER",
    targetId: target.id,
    metadata: { previousRole: target.role, role },
    result: "SUCCESS",
    sourceIp
  });
  return true;
}

/**
 * Remove (rather than delete) an organization membership. The identity and
 * its audit history remain for platform administrators. Removing access also
 * disables the account until it is assigned to an organization again.
 */
export async function removeTeamMembership(
  session: AuthSession,
  userId: string,
  sourceIp: string | null
): Promise<boolean> {
  const clientId = assertClientAdmin(session);
  const target = await prisma.user.findFirst({
    where: { id: userId, clientAccountId: clientId },
    select: { id: true, role: true, authSource: true, email: true }
  });
  if (!target || target.role === Role.ADMIN || target.role === Role.CLIENT_ADMIN || target.authSource === AuthSource.PAM) {
    return false;
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: target.id },
      data: { clientAccountId: null, isActive: false }
    });
    await tx.session.deleteMany({ where: { userId: target.id } });
    await tx.activationToken.deleteMany({ where: { userId: target.id } });
  });

  await logAuditEvent({
    actorUserId: session.userId,
    actorEmail: session.email,
    actorRole: session.role,
    clientAccountId: clientId,
    action: "MEMBERSHIP_REMOVED",
    targetType: "USER",
    targetId: target.id,
    metadata: { removedEmail: target.email, previousRole: target.role },
    result: "SUCCESS",
    sourceIp
  });
  return true;
}
