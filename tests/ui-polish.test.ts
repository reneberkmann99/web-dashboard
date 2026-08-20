import { describe, expect, it } from "vitest";
import { humanizeAction } from "@/lib/format";
import { contentWidthClass } from "@/components/layout/dashboard-shell";

describe("UI consistency polish", () => {
  it.each([
    ["project_convert_to_compose", "Converted to Compose"],
    ["compose_adopt", "Adopted Compose project"],
    ["workload_restart", "Restarted workload"],
    ["ATTENTION_OPENED_CONTAINER_UNHEALTHY", "Container became unhealthy"],
    ["ATTENTION_RESOLVED_CONTAINER_UNHEALTHY", "Container recovered"],
    ["ATTENTION_OPENED_WORKLOAD_DEGRADED", "Workload became degraded"],
    ["ATTENTION_RESOLVED_WORKLOAD_DEGRADED", "Workload returned healthy"],
    ["maintenance_scheduled", "Maintenance scheduled"]
  ])("humanizes %s", (action, label) => {
    expect(humanizeAction(action)).toBe(label);
  });

  it("uses intentional standard, wide, and editor page widths", () => {
    expect(contentWidthClass("/admin/nodes")).toContain("max-w-[1536px]");
    expect(contentWidthClass("/admin/nodes/node-1")).toContain("max-w-7xl");
    expect(contentWidthClass("/admin/containers/node/container")).toContain("max-w-[1680px]");
  });
});
