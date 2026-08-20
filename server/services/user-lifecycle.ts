import crypto from "node:crypto";
import { AuthSource, Role } from "@prisma/client";
import { prisma } from "@/server/db";
import { logAuditEvent } from "@/server/audit";
import type { AuthSession } from "@/server/auth/session";

/**
 * ADMIN user lifecycle (Section 3 / 15 of the usability phase).
 *
 * Deactivate vs Delete are deliberately distinct:
 *  - Deactivate: `isActive=false` — login immediately denied (session guard
 *    checks `user.isActive`), permissions stop working, account + history
 *    remain, reversible via reactivation.
 *  - Delete: hard-deletes the User row (removes PPI: email, display name,
 *    password hash). Audit/Activity integrity is preserved by the schema's
 *    actor snapshots — AuditLog/Operation/Revision/etc. keep `actorEmail` /
 *    `actorRole` snapshot columns and SetNull the `actorUserId` FK, so
 *    history survives with a tombstone rather than a dangling reference.
 *
 * Guards:
 *  - cannot delete the last active ADMIN (or the last recovery admin);
 *  - cannot delete yourself if doing so would leave zero active admins;
 *  - PAM users are deletable (their OS account is untouched; only the local
 *    User row is removed).
 */

const ACTIVATION_TTL_HOURS = 72;

export class UserLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserLifecycleError";
  }
}

function assertAdmin(session: AuthSession): void {
  if (session.role !== Role.ADMIN) {
    throw new UserLifecycleError("FORBIDDEN");
  }
}

export type DeletedUserSnapshot = {
  id: string;
  email: string;
  displayName: string;
  role: Role;
};

/**
 * Counts ACTIVE ADMIN users. Used to enforce the "never leave the platform
 * without an administrator" invariant before a deactivation or delete.
 */
export async function countActiveAdmins(): Promise<number> {
  return prisma.user.count({
    where: { role: Role.ADMIN, isActive: true }
  });
}

/**
 * Hard-delete a user. Returns the deleted user's snapshot for audit metadata.
 * Throws:
 *  - "NOT_FOUND"        if the user does not exist
 *  - "LAST_ADMIN"       if the delete would remove the last active admin
 */
export async function deleteUser(
  session: AuthSession,
  targetId: string,
  sourceIp: string | null
): Promise<DeletedUserSnapshot> {
  assertAdmin(session);

  const target = await prisma.user.findUnique({ where: { id: targetId } });
  if (!target) {
    throw new UserLifecycleError("NOT_FOUND");
  }

  if (target.role === Role.ADMIN && target.isActive) {
    const activeAdmins = await countActiveAdmins();
    if (activeAdmins <= 1) {
      throw new UserLifecycleError("LAST_ADMIN");
    }
  }

  // Removing an active ADMIN (self included) must always leave ≥1 active admin.
  if (target.id === session.userId && target.role === Role.ADMIN) {
    const activeAdmins = await countActiveAdmins();
    if (activeAdmins <= 1) {
      throw new UserLifecycleError("LAST_ADMIN");
    }
  }

  const snapshot: DeletedUserSnapshot = {
    id: target.id,
    email: target.email,
    displayName: target.displayName,
    role: target.role
  };

  // Cascade removes: Session (invalidate sessions), ActivationToken (remove
  // invitations/tokens). SetNull relations preserve Operation/Revision/
  // SecretVersion/acknowledgement history via actor snapshot columns.
  await prisma.user.delete({ where: { id: targetId } });

  await logAuditEvent({
    actorUserId: session.userId,
    actorEmail: session.email,
    actorRole: session.role,
    action: "USER_DELETE",
    targetType: "USER",
    targetId: snapshot.id,
    metadata: {
      deletedEmail: snapshot.email,
      deletedDisplayName: snapshot.displayName,
      deletedRole: snapshot.role
    },
    result: "SUCCESS",
    sourceIp
  });

  return snapshot;
}

/**
 * Deactivate (isActive=false) or reactivate (isActive=true) a user.
 * Deactivation immediately denies login (session guard re-checks isActive) and
 * stops permissions; the account and its history remain, and reactivation is
 * reversible. Refuses to deactivate the last active admin.
 */
export async function setUserActive(
  session: AuthSession,
  targetId: string,
  isActive: boolean,
  sourceIp: string | null
): Promise<{ id: string; role: Role }> {
  assertAdmin(session);

  const target = await prisma.user.findUnique({ where: { id: targetId } });
  if (!target) {
    throw new UserLifecycleError("NOT_FOUND");
  }

  if (!isActive && target.role === Role.ADMIN && target.isActive) {
    const activeAdmins = await countActiveAdmins();
    if (activeAdmins <= 1) {
      throw new UserLifecycleError("LAST_ADMIN");
    }
  }

  await prisma.user.update({ where: { id: targetId }, data: { isActive } });

  await logAuditEvent({
    actorUserId: session.userId,
    actorEmail: session.email,
    actorRole: session.role,
    action: isActive ? "USER_ACTIVATE" : "USER_DEACTIVATE",
    targetType: "USER",
    targetId: target.id,
    metadata: { targetRole: target.role },
    result: "SUCCESS",
    sourceIp
  });

  return { id: target.id, role: target.role };
}

/**
 * Regenerate the activation token for a still-pending user (resend/reset
 * activation). Only valid while the user has not yet activated; throws
 * "ALREADY_ACTIVE" otherwise. The token is single-use and hashed at rest.
 */
export async function resendUserActivation(
  session: AuthSession,
  targetId: string,
  sourceIp: string | null
): Promise<{ activationUrl: string; activationExpiresAt: string }> {
  assertAdmin(session);

  const target = await prisma.user.findUnique({
    where: { id: targetId },
    select: { id: true, isActive: true, authSource: true }
  });
  if (!target) {
    throw new UserLifecycleError("NOT_FOUND");
  }
  if (target.isActive || target.authSource === AuthSource.PAM) {
    throw new UserLifecycleError("ALREADY_ACTIVE");
  }

  const rawToken = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + ACTIVATION_TTL_HOURS * 60 * 60 * 1000);
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

  await prisma.activationToken.upsert({
    where: { userId: target.id },
    update: { tokenHash, expiresAt, usedAt: null },
    create: { userId: target.id, tokenHash, expiresAt }
  });

  await logAuditEvent({
    actorUserId: session.userId,
    actorEmail: session.email,
    actorRole: session.role,
    action: "USER_REINVITE",
    targetType: "USER",
    targetId: target.id,
    result: "SUCCESS",
    sourceIp
  });

  return {
    activationUrl: `/activate?token=${rawToken}`,
    activationExpiresAt: expiresAt.toISOString()
  };
}
