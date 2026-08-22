import { describe, expect, it } from "vitest";
import { Role } from "@prisma/client";
import { capabilitiesForRole } from "@/server/auth/policy";
import {
  ADMIN_ROOTS,
  CLIENT_ROOTS,
  ORGANIZATION_OPERATIONAL_KEYS,
  PLATFORM_NAV_KEYS,
  deriveFallback,
  navigationKeysForRole
} from "@/lib/navigation";

describe("organization navigation policy", () => {
  it("exposes the exact platform-admin navigation order", () => {
    expect(PLATFORM_NAV_KEYS).toEqual([
      "overview", "workloads", "containers", "attention", "activity",
      "nodes", "organizations", "users", "alerting", "platformSettings"
    ]);
    expect(PLATFORM_NAV_KEYS.map((key) => ADMIN_ROOTS[key].label)).toEqual([
      "Overview", "Workloads", "Containers", "Attention", "Activity",
      "Nodes", "Organizations", "All Users", "Alerting", "Platform Settings"
    ]);
  });

  it("gives organization admins member/settings access and operators/viewers only operational roots", () => {
    expect(navigationKeysForRole("CLIENT_ADMIN")).toEqual([
      ...ORGANIZATION_OPERATIONAL_KEYS, "members", "settings"
    ]);
    expect(navigationKeysForRole("CLIENT_OPERATOR")).toEqual(ORGANIZATION_OPERATIONAL_KEYS);
    expect(navigationKeysForRole("CLIENT_VIEWER")).toEqual(ORGANIZATION_OPERATIONAL_KEYS);
    expect(capabilitiesForRole(Role.CLIENT_OPERATOR)).not.toContain("node.manage");
    expect(capabilitiesForRole(Role.CLIENT_VIEWER)).not.toContain("user.manage");
  });

  it("derives canonical organization roots while retaining legacy client URLs", () => {
    expect(deriveFallback("/organization/workloads", "")?.rootHref).toBe("/organization/workloads");
    expect(deriveFallback("/organization/members", "")?.stack[0].label).toBe("Members");
    expect(deriveFallback("/organizations/example", "")?.stack[1].label).toBe("Organization");
    expect(deriveFallback("/client/workloads", "")?.rootHref).toBe("/organization/workloads");
    expect(CLIENT_ROOTS.settings.href).toBe("/organization/settings");
  });
});
