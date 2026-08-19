/**
 * Execution-safety capability gate (Phase 6B.0/6B.2).
 *
 * Managed deployment EXECUTION (which sends real secret values to the agent)
 * is enabled ONLY when ALL of:
 *   - node is active
 *   - secure agent transport (Node.transportMode === TLS_VERIFIED)
 *   - agent reports Docker Compose v2 (Node.composeSupported === true)
 *   - fleet-wide executor flag not disabled (DEPLOYMENT_EXECUTION_ENABLED)
 *
 * Phase 6A read-only validation used deterministic sentinels and therefore did
 * not require TLS. Phase 6B crosses the secret-bearing boundary, so execution
 * is hard-gated on secure transport. A LEGACY_HTTP node can still be inventoried,
 * inspected, and validated — but never asked to deploy.
 */

export type ExecutionCapability = {
  supported: boolean;
  reason: string | null;
};

export function managedDeploymentExecutionSupported(node: {
  isActive: boolean;
  transportMode: string;
  composeSupported: boolean | null;
}): ExecutionCapability {
  if (!node.isActive) {
    return { supported: false, reason: "Node is inactive." };
  }
  if (node.transportMode !== "TLS_VERIFIED") {
    return {
      supported: false,
      reason:
        "Managed deployment is unavailable on this node because secure agent transport has not been configured."
    };
  }
  if (node.composeSupported !== true) {
    return { supported: false, reason: "Docker Compose v2 is not available on this node." };
  }
  if (process.env.DEPLOYMENT_EXECUTION_ENABLED === "false") {
    return { supported: false, reason: "Managed deployment execution is disabled." };
  }
  return { supported: true, reason: null };
}
