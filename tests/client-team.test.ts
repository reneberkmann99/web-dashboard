import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "./helpers/db";
import { resetDatabase } from "./setup";
import { seedWorld, sessionFor } from "./helpers/fixtures";
import {
  listTeamUsers,
  inviteTeamUser,
  reissueInvite,
  setTeamUserActive,
  ClientTeamForbiddenError
} from "@/server/services/client-team";

beforeAll(async () => {
  resetDatabase();
});

async function expectForbidden(fn: () => Promise<unknown>): Promise<void> {
  await expect(fn()).rejects.toThrow(ClientTeamForbiddenError);
}

describe("client team management", () => {
  it("CLIENT_ADMIN lists only their own client's users", async () => {
    const world = await seedWorld();
    const adminA = sessionFor(world.clientAAdmin);

    const users = await listTeamUsers(adminA);
    const emails = users.map((u) => u.email);

    expect(emails).toContain(world.clientAOperator.email);
    expect(emails).toContain(world.clientAViewer.email);
    expect(emails).toContain(world.clientAAdmin.email);
    // Never the other client's users, nor platform admins.
    expect(emails).not.toContain(world.clientBOperator.email);
    expect(emails).not.toContain(world.adminA.email);
  });

  it("CLIENT_ADMIN invites an operator scoped to their own client", async () => {
    const world = await seedWorld();
    const adminA = sessionFor(world.clientAAdmin);

    const result = await inviteTeamUser(
      adminA,
      { email: "new-op@client-a.local", displayName: "New Op", role: "CLIENT_OPERATOR" },
      null
    );

    const created = await prisma.user.findUnique({
      where: { id: result.id },
      include: { activationToken: true }
    });
    expect(created?.clientAccountId).toBe(world.clientA.id);
    expect(created?.role).toBe("CLIENT_OPERATOR");
    expect(created?.isActive).toBe(false);
    expect(created?.passwordHash).toBeNull();
    expect(created?.activationToken).not.toBeNull();
    expect(result.activationUrl).toContain("/activate?token=");
  });

  it("CLIENT_ADMIN cannot invite an ADMIN", async () => {
    const world = await seedWorld();
    await expectForbidden(() =>
      inviteTeamUser(sessionFor(world.clientAAdmin), { email: "x@x.com", displayName: "X", role: "ADMIN" as never }, null)
    );
  });

  it("CLIENT_ADMIN cannot invite another CLIENT_ADMIN (no elevation)", async () => {
    const world = await seedWorld();
    await expectForbidden(() =>
      inviteTeamUser(
        sessionFor(world.clientAAdmin),
        { email: "x@x.com", displayName: "X", role: "CLIENT_ADMIN" as never },
        null
      )
    );
  });

  it("CLIENT_ADMIN cannot manage another client's users", async () => {
    const world = await seedWorld();
    const adminA = sessionFor(world.clientAAdmin);

    // B's operator id must be unreachable via A's team endpoints.
    const changed = await setTeamUserActive(adminA, world.clientBOperator.id, false, null);
    expect(changed).toBe(false);

    const reinvited = await reissueInvite(adminA, world.clientBOperator.id, null);
    expect(reinvited).toBeNull();
  });

  it("CLIENT_ADMIN cannot deactivate themselves", async () => {
    const world = await seedWorld();
    const adminA = sessionFor(world.clientAAdmin);
    const changed = await setTeamUserActive(adminA, adminA.userId, false, null);
    expect(changed).toBe(false);
  });

  it("CLIENT_ADMIN can deactivate an operator, and the operator loses access", async () => {
    const world = await seedWorld();
    const adminA = sessionFor(world.clientAAdmin);

    const changed = await setTeamUserActive(adminA, world.clientAOperator.id, false, null);
    expect(changed).toBe(true);

    const target = await prisma.user.findUnique({ where: { id: world.clientAOperator.id } });
    expect(target?.isActive).toBe(false);
  });

  it("CLIENT_OPERATOR and CLIENT_VIEWER cannot manage users", async () => {
    const world = await seedWorld();

    await expectForbidden(() => listTeamUsers(sessionFor(world.clientAOperator)));
    await expectForbidden(() => listTeamUsers(sessionFor(world.clientAViewer)));

    await expectForbidden(() =>
      inviteTeamUser(sessionFor(world.clientAOperator), { email: "x@x.com", displayName: "X", role: "CLIENT_VIEWER" }, null)
    );
  });

  it("platform ADMIN is rejected from client team endpoints (admin uses /api/admin/users)", async () => {
    const world = await seedWorld();
    await expectForbidden(() => listTeamUsers(sessionFor(world.adminA)));
  });
});
