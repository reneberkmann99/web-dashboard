import { beforeAll, describe, expect, it } from "vitest";
import { Role } from "@prisma/client";
import { prisma } from "./helpers/db";
import { resetDatabase } from "./setup";
import { seedWorld, sessionFor } from "./helpers/fixtures";
import { capabilitiesForRole, can, ensureCan } from "@/server/auth/policy";

beforeAll(async () => {
  resetDatabase();
  await seedWorld();
});

describe("capability model", () => {
  it("ADMIN has every capability including node.manage", () => {
    const caps = capabilitiesForRole(Role.ADMIN);
    expect(caps).toContain("node.manage");
    expect(caps).toContain("platform.admin");
    expect(caps).toContain("container.restart");
    expect(caps).toContain("client.manage");
    expect(caps).toContain("user.manage");
  });

  it("no client role ever gets node.manage", () => {
    for (const role of [Role.CLIENT_ADMIN, Role.CLIENT_OPERATOR, Role.CLIENT_VIEWER, Role.CLIENT]) {
      expect(capabilitiesForRole(role)).not.toContain("node.manage");
      expect(capabilitiesForRole(role)).not.toContain("platform.admin");
    }
  });

  it("CLIENT_ADMIN manages its own client users but not platform users", () => {
    const caps = capabilitiesForRole(Role.CLIENT_ADMIN);
    expect(caps).toContain("user.manage");
    expect(caps).toContain("client.manage");
    expect(caps).toContain("container.start");
  });

  it("CLIENT_OPERATOR can operate assigned workloads", () => {
    const caps = capabilitiesForRole(Role.CLIENT_OPERATOR);
    expect(caps).toContain("container.start");
    expect(caps).toContain("container.stop");
    expect(caps).toContain("container.restart");
    expect(caps).toContain("container.view_logs");
    expect(caps).toContain("project.view");
  });

  it("CLIENT_VIEWER is read-only", () => {
    const caps = capabilitiesForRole(Role.CLIENT_VIEWER);
    expect(caps).toContain("container.view_logs");
    expect(caps).toContain("project.view");
    expect(caps).not.toContain("container.start");
    expect(caps).not.toContain("container.stop");
    expect(caps).not.toContain("container.restart");
  });

  it("ensureCan throws FORBIDDEN for disallowed capabilities", async () => {
    const world = await seedWorld();
    const viewer = sessionFor(world.clientAViewer);

    expect(() => ensureCan(viewer, "container.view_logs")).not.toThrow();
    expect(() => ensureCan(viewer, "container.start")).toThrow("FORBIDDEN");
    expect(() => ensureCan(viewer, "node.manage")).toThrow("FORBIDDEN");
    expect(can(viewer, "node.manage")).toBe(false);
  });

  it("inactive users and disabled nodes are refused by service guards", async () => {
    const world = await seedWorld();

    // Deactivate client A — its operator must see nothing.
    await prisma.clientAccount.update({ where: { id: world.clientA.id }, data: { isActive: false } });
    const sessionA = sessionFor(world.clientAOperator);
    const { resolveVisibleContainersForSession } = await import("@/server/services/containers");
    const visible = await resolveVisibleContainersForSession(sessionA);
    expect(visible.size).toBe(0);
    await prisma.clientAccount.update({ where: { id: world.clientA.id }, data: { isActive: true } });
  });
});
