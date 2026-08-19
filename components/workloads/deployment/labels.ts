import { isApiError } from "@/lib/fetcher";

/**
 * Human-facing translations for known lifecycle API errors. Technical detail
 * stays available separately (raw message) — never a raw stack trace.
 */

export function deploymentErrorMessage(error: unknown): string {
  if (isApiError(error)) {
    switch (error.code) {
      case "PLAN_STALE":
        return "The deployment plan is out of date — the workload or its secrets changed after the plan was generated. Generate a fresh plan before deploying.";
      case "EXECUTION_UNSUPPORTED":
        return `This node cannot run managed deployments right now. ${error.message || ""}`.trim();
      case "DEPLOYMENT_OP_IN_PROGRESS":
        return "Another deployment operation is already running on this workload. Wait for it to finish or view it first.";
      case "CONTAINER_OP_IN_PROGRESS":
        return "A container operation is in progress on this workload. Try again once it completes.";
      case "DEPLOYMENT_INVALID":
        return "The configuration is invalid. Review the validation errors below.";
      case "SECURITY_ACK_REQUIRED":
        return "This configuration has high-risk findings that must be acknowledged before saving.";
      case "SECURITY_BLOCKED":
        return "This configuration is blocked by the deployment security policy.";
      case "MISSING_SECRET":
        return "A referenced secret has no value yet. Create or rotate the secret first.";
      case "COMPOSE_UNAVAILABLE":
        return "Docker Compose v2 is not available on this node.";
      case "SECRET_KEY_UNAVAILABLE":
        return "The deployment secrets encryption key is not configured on this control plane.";
      case "NOT_FOUND":
        return "The requested item no longer exists. Refresh the page.";
      case "UNAUTHORIZED":
        return "Your session has expired. Sign in again.";
      case "FORBIDDEN":
        return "You don't have permission to do that.";
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}

export function operationPhaseLabel(phase: string | null, state: string): string {
  if (state === "REQUESTED" || state === "QUEUED") return "Queued";
  if (state === "SUCCEEDED") return "Completed";
  if (state === "CANCELLED") return "Cancelled";
  switch (phase) {
    case "PREPARING":
      return "Preparing";
    case "PULLING":
      return "Pulling images";
    case "APPLYING":
      return "Applying configuration";
    case "VERIFYING":
      return "Verifying health";
    case "RECONCILING":
      return "Recording result";
    default:
      return "Running";
  }
}

export const RUNTIME_STATE_LABELS: Record<string, string> = {
  UNKNOWN: "Runtime state unknown",
  CONVERGED: "Runtime converged",
  DEGRADED: "Runtime running the deployed configuration, but health verification failed",
  DRIFTED: "Runtime differs from the expected deployment state"
};

export const RELEASE_HEALTH_LABELS: Record<string, string> = {
  HEALTHY: "Healthy",
  DEGRADED: "Degraded"
};
