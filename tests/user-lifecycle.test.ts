import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "./helpers/db";
import { resetDatabase } from "./setup";
import { seedWorld, sessionFor } from "./helpers/fixtures";
import {
  deleteUser,
  setUserActive,
  resendUserActivation,
  countActiveAdmins,
  UserLifecycleError
} from "@/server/services/user-lifecycle";
import { hashPassword } from "@/server/auth/password";
import { Role } from "@prisma/client";

beforeAll(async () => {
  resetDatabase();
});

async function expectError(fn: () => Promise<unknown>, message: string): Promise<void> {
  await expect(fn()).rejects.toThrow(message);
}

/**
 * `seedWorld()` is called once per test and accumulates admins across a file.
 * For "last admin" guard tests, deactivate every active admin except the
 * target so the guard's count is deterministic.
 */
async function ensureSoleActiveAdmin(userId: string): Promise<void> {
  await prisma.user.updateMany({
    where: { role: Role.ADMIN, isActive: true, id: { not: userId } },
    data: { isActive: false }
  });
}

describe("admin user lifecycle — delete / deactivate / resend activation", () => {
  it("refuses to delete the last active ADMIN", async () => {
    const world = await seedWorld();
    await ensureSoleActiveAdmin(world.adminA.id);
    const admin = sessionFor(world.adminA);

    await expectError(() => deleteUser(admin, world.adminA.id, null), "LAST_ADMIN");
    // User still exists.
    expect(await prisma.user.findUnique({ where: { id: world.adminA.id } })).not.toBeNull();
  });

  it("refuses to delete yourself when you are the last active admin", async () => {
    const world = await seedWorld();
    await ensureSoleActiveAdmin(world.adminA.id);
    const admin = sessionFor(world.adminA);

    await expectError(() => deleteUser(admin, world.adminA.id, null), "LAST_ADMIN");
  });

  it("deletes a non-admin user and preserves audit history via actor snapshot", async () => {
    const world = await seedWorld();
    const admin = sessionFor(world.adminA);

    // Give the target an open session + activation token so we can assert cascade.
    await prisma.session.create({
      data: { userId: world.clientAOperator.id, tokenHash: "t-" + world.clientAOperator.id, expiresAt: new Date(Date.now() + 100000) }
    });
    await prisma.activationToken.create({
      data: { userId: world.clientAOperator.id, tokenHash: "a-" + world.clientAOperator.id, expiresAt: new Date(Date.now() + 100000) }
    });

    // Write an audit event authored by the target, to verify tombstone snapshot survives.
    await prisma.auditLog.create({
      data: {
        actorUserId: world.clientAOperator.id,
        actorEmail: world.clientAOperator.email,
        actorRole: world.clientAOperator.role,
        action: "CONTAINER_START",
        targetType: "CONTAINER",
        targetId: "whatever",
        result: "SUCCESS"
      }
    });

    const snapshot = await deleteUser(admin, world.clientAOperator.id, null);

    expect(snapshot.email).toBe(world.clientAOperator.email);
    // User row gone (PPI removed).
    expect(await prisma.user.findUnique({ where: { id: world.clientAOperator.id } })).toBeNull();
    // Sessions + activation tokens cascaded away.
    expect(await prisma.session.findMany({ where: { userId: world.clientAOperator.id } })).toEqual([]);
    expect(await prisma.activationToken.findMany({ where: { userId: world.clientAOperator.id } })).toEqual([]);
    // Audit history survives via actor snapshot columns (FK set null, email/role remain).
    const history = await prisma.auditLog.findFirst({
      where: { actorEmail: world.clientAOperator.email, action: "CONTAINER_START" }
    });
    expect(history).not.toBeNull();
    expect(history?.actorUserId).toBeNull();
    expect(history?.actorRole).toBe("CLIENT_OPERATOR");
  });

  it("allows deleting an ADMIN when another active admin remains", async () => {
    const world = await seedWorld();
    const admin = sessionFor(world.adminA);

    const secondAdmin = await prisma.user.create({
      data: {
        email: `second-admin@hostpanel.local`,
        displayName: "Second Admin",
        passwordHash: await hashPassword("Sup3rSecret!42"),
        role: Role.ADMIN,
        isActive: true
      }
    });

    const before = await countActiveAdmins();
    await deleteUser(admin, secondAdmin.id, null);
    expect(await prisma.user.findUnique({ where: { id: secondAdmin.id } })).toBeNull();
    expect(await countActiveAdmins()).toBe(before - 1);
  });

  it("a client role cannot delete users through the admin service", async () => {
    const world = await seedWorld();
    const clientAdminA = sessionFor(world.clientAAdmin);

    await expectError(() => deleteUser(clientAdminA, world.clientAOperator.id, null), "FORBIDDEN");
  });

  it("deactivate refuses to disable the last active admin; reactivate is reversible", async () => {
    const world = await seedWorld();
    const admin = sessionFor(world.adminA);

    await ensureSoleActiveAdmin(world.adminA.id);
    await expectError(() => setUserActive(admin, world.adminA.id, false, null), "LAST_ADMIN");

    // Deactivate + reactivate a normal operator is fine.
    await setUserActive(admin, world.clientAOperator.id, false, null);
    expect((await prisma.user.findUnique({ where: { id: world.clientAOperator.id } }))?.isActive).toBe(false);

    await setUserActive(admin, world.clientAOperator.id, true, null);
    expect((await prisma.user.findUnique({ where: { id: world.clientAOperator.id } }))?.isActive).toBe(true);
  });

  it("resend activation regenerates the token for a pending user", async () => {
    const world = await seedWorld();
    const admin = sessionFor(world.adminA);

    const pending = await prisma.user.create({
      data: {
        email: "pending@hostpanel.local",
        displayName: "Pending User",
        passwordHash: null,
        role: Role.CLIENT_OPERATOR,
        clientAccountId: world.clientA.id,
        isActive: false
      }
    });
    await prisma.activationToken.create({
      data: { userId: pending.id, tokenHash: "oldhash", expiresAt: new Date(Date.now() - 1000) }
    });

    const result = await resendUserActivation(admin, pending.id, null);
    expect(result.activationUrl).toContain("/activate?token=");

    const token = await prisma.activationToken.findUnique({ where: { userId: pending.id } });
    expect(token?.tokenHash).not.toBe("oldhash");
    expect(token?.usedAt).toBeNull();
    expect(token?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("resend activation is rejected for an already-active user", async () => {
    const world = await seedWorld();
    const admin = sessionFor(world.adminA);

    await expectError(() => resendUserActivation(admin, world.clientAOperator.id, null), "ALREADY_ACTIVE");
  });
});
