import { describe, expect, it } from "vitest";
import { decideVerifyVerdict } from "../agent/src/deployments/verdict";

/**
 * Regression tests for the health-classification rules used by the agent's
 * verify endpoint. Found during live qualification: a healthcheck that had not
 * produced a result yet ("starting") was classified as HEALTHY, which made a
 * deliberately-degraded deployment report success before the healthcheck
 * failed. "starting" must classify as PENDING (not healthy).
 */
describe("agent verify verdict decision (deployments/verdict)", () => {
  const base = {
    expectedServices: ["app", "sidecar"],
    presentServices: ["app", "sidecar"],
    runningCount: 2,
    unhealthyCount: 0,
    startingCount: 0
  };

  it("all running and healthy → CONVERGED_HEALTHY", () => {
    expect(decideVerifyVerdict(base)).toBe("CONVERGED_HEALTHY");
  });

  it("no healthcheck + running → CONVERGED_HEALTHY", () => {
    expect(decideVerifyVerdict({ ...base, runningCount: 2 })).toBe("CONVERGED_HEALTHY");
  });

  it("any unhealthy service → CONVERGED_DEGRADED", () => {
    expect(decideVerifyVerdict({ ...base, unhealthyCount: 1 })).toBe("CONVERGED_DEGRADED");
  });

  it("unhealthy wins over starting", () => {
    expect(decideVerifyVerdict({ ...base, unhealthyCount: 1, startingCount: 1 })).toBe("CONVERGED_DEGRADED");
  });

  it("healthcheck still starting → PENDING (never HEALTHY)", () => {
    expect(decideVerifyVerdict({ ...base, startingCount: 1 })).toBe("PENDING");
  });

  it("missing service → DRIFTED", () => {
    expect(decideVerifyVerdict({ ...base, presentServices: ["app"] })).toBe("DRIFTED");
  });

  it("not enough running → DRIFTED", () => {
    expect(decideVerifyVerdict({ ...base, runningCount: 1 })).toBe("DRIFTED");
  });

  it("empty runtime (containers not visible yet) → DRIFTED", () => {
    expect(decideVerifyVerdict({ ...base, presentServices: [], runningCount: 0 })).toBe("DRIFTED");
  });
});
