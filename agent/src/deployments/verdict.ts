/**
 * Pure verdict decision for managed-deployment runtime verification.
 *
 * Extracted from the verify endpoint so the health-classification rules are
 * unit-testable without an HTTP server or Docker. The rules:
 *
 *   - any expected service missing / not running          → DRIFTED
 *   - all present+running, any unhealthy                  → CONVERGED_DEGRADED
 *   - all present+running, any healthcheck still starting → PENDING
 *     (health is NOT yet determined — the caller must poll again within its
 *     grace window; reporting HEALTHY here caused false-green deploys when a
 *     healthcheck was about to fail)
 *   - all present+running, everything healthy (or no healthcheck) → CONVERGED_HEALTHY
 */

export type VerifyVerdict = "CONVERGED_HEALTHY" | "CONVERGED_DEGRADED" | "PENDING" | "DRIFTED" | "FAILED";

export function decideVerifyVerdict(input: {
  expectedServices: string[];
  presentServices: string[];
  runningCount: number;
  unhealthyCount: number;
  startingCount: number;
}): VerifyVerdict {
  const present = new Set(input.presentServices);
  const missing = input.expectedServices.filter((e) => !present.has(e));
  if (missing.length > 0 || input.runningCount < input.expectedServices.length) {
    return "DRIFTED";
  }
  if (input.unhealthyCount > 0) {
    return "CONVERGED_DEGRADED";
  }
  if (input.startingCount > 0) {
    return "PENDING";
  }
  return "CONVERGED_HEALTHY";
}
