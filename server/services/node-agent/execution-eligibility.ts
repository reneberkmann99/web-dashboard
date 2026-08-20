import type { Node } from "@prisma/client";
import { getActiveCertificate } from "@/server/services/node-agent/secure-transport";
import { caExists } from "@/server/security/agent-pki";

/**
 * THE single authoritative managed-deployment execution eligibility check.
 *
 * Every route/service asks this — no route implements its own variant.
 * Note that passing this check is NECESSARY BUT NOT SUFFICIENT: the actual
 * request still performs full TLS verification in `secureFetch` (CA chain +
 * logical identity SAN + active-certificate pinning). `transportMode` is a
 * status hint and can never by itself authorize sending secrets.
 */

export type EligibilityReason =
  | "NODE_DISABLED"
  | "AGENT_CA_NOT_CONFIGURED"
  | "AGENT_TLS_NOT_VERIFIED"
  | "NO_TLS_ENDPOINT"
  | "NO_ACTIVE_CERTIFICATE"
  | "CERTIFICATE_NOT_YET_VALID"
  | "CERTIFICATE_EXPIRED"
  | "COMPOSE_UNSUPPORTED"
  | "COMPOSE_VERSION_UNSUPPORTED"
  | "EXECUTION_DISABLED";

export type ExecutionEligibility = {
  allowed: boolean;
  reasons: EligibilityReason[];
  /** Human-readable explanation for the first blocking reason. */
  message: string | null;
};

const REASON_MESSAGES: Record<EligibilityReason, string> = {
  NODE_DISABLED: "Node is disabled or inactive.",
  AGENT_CA_NOT_CONFIGURED: "The Noderaft Agent CA is not configured on the control plane.",
  AGENT_TLS_NOT_VERIFIED:
    "Managed deployment is unavailable on this node because secure agent transport has not been configured.",
  NO_TLS_ENDPOINT: "Node has no verified HTTPS endpoint.",
  NO_ACTIVE_CERTIFICATE: "Node has no active agent certificate.",
  CERTIFICATE_NOT_YET_VALID: "Node agent certificate is not yet valid.",
  CERTIFICATE_EXPIRED: "Node agent certificate has expired.",
  COMPOSE_UNSUPPORTED: "Docker Compose v2 is not available on this node.",
  COMPOSE_VERSION_UNSUPPORTED: "The node's Docker Compose version is below the supported minimum.",
  EXECUTION_DISABLED: "Managed deployment execution is disabled."
};

/** Minimum Compose version for managed execution (config/pull/up -d/ps). */
export const MIN_COMPOSE_MAJOR = 2;

function composeVersionSupported(version: string | null): boolean {
  if (!version) return false;
  const m = /v?(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return false;
  return Number(m[1]) >= MIN_COMPOSE_MAJOR;
}

export async function getManagedExecutionEligibility(node: Node): Promise<ExecutionEligibility> {
  const reasons: EligibilityReason[] = [];

  if (!node.isActive || node.status === "INACTIVE") reasons.push("NODE_DISABLED");
  if (!caExists()) reasons.push("AGENT_CA_NOT_CONFIGURED");
  if (process.env.DEPLOYMENT_EXECUTION_ENABLED === "false") reasons.push("EXECUTION_DISABLED");
  if (node.composeSupported !== true) reasons.push("COMPOSE_UNSUPPORTED");
  else if (!composeVersionSupported(node.composeVersion)) reasons.push("COMPOSE_VERSION_UNSUPPORTED");

  if (node.transportMode !== "TLS_VERIFIED") reasons.push("AGENT_TLS_NOT_VERIFIED");
  if (!node.tlsApiBaseUrl) reasons.push("NO_TLS_ENDPOINT");

  const active = await getActiveCertificate(node.id);
  if (!active) {
    reasons.push("NO_ACTIVE_CERTIFICATE");
  } else {
    const now = Date.now();
    if (active.notBefore.getTime() > now) reasons.push("CERTIFICATE_NOT_YET_VALID");
    if (active.notAfter.getTime() < now) reasons.push("CERTIFICATE_EXPIRED");
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    message: reasons.length > 0 ? REASON_MESSAGES[reasons[0]] : null
  };
}
