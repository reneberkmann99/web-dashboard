import { parse } from "yaml";
import { prisma } from "@/server/db";
import { ensureCan } from "@/server/auth/policy";
import { createRevision } from "@/server/services/deployments";
import { serializeForm } from "@/lib/compose-form/serialize";
import { parseComposeToForm } from "@/lib/compose-form/parse";
import type { AuthSession } from "@/server/auth/session";

/**
 * Managed SERVICE removal (Section 5).
 *
 * A service belonging to a managed workload is NEVER removed with `docker rm`.
 * The only supported path is:
 *
 *   remove service from the workload definition
 *     → new immutable revision (validated on the node like any other)
 *     → deployment plan (the service shows as REMOVE_CANDIDATE)
 *     → explicit confirmation
 *     → deploy (Compose reconciles the runtime)
 *
 * This module performs step 1 and 2 only. It never mutates Docker, never
 * deletes a volume, and never removes a network. Named volumes are preserved by
 * default and are not even referenced here — nothing in this file can delete
 * data.
 */

export class WorkloadServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkloadServiceError";
  }
}

export type ServiceRemovalImpact = {
  deploymentId: string;
  serviceName: string;
  /** Containers that will be removed when the resulting plan is deployed. */
  containersRemoved: Array<{ dockerName: string; dockerContainerId: string; image: string | null }>;
  /** Networks the workload declares that no remaining service references. */
  networksNoLongerUsed: string[];
  /** Networks retained because other services still reference them. */
  networksRetained: string[];
  /** Named volumes the service mounted — ALWAYS retained (data preserved). */
  volumesRetained: string[];
  /** Secret keys only this service referenced; retained unless explicitly removed. */
  secretsNoLongerReferenced: string[];
  /** Secret keys still referenced by remaining services. */
  secretsRetained: string[];
  /** Services that remain after the removal. */
  remainingServices: string[];
  /** True when removing this service would empty the workload. */
  removesLastService: boolean;
};

type Scope = "ADMIN" | "CLIENT";

async function loadContext(deploymentId: string, session: AuthSession, scope: Scope) {
  const deployment = await prisma.deployment.findUnique({
    where: { id: deploymentId },
    include: {
      project: { select: { id: true, name: true, nodeId: true, clientAccountId: true } }
    }
  });
  if (!deployment) throw new WorkloadServiceError("NOT_FOUND");

  if (scope === "CLIENT") {
    if (!session.clientAccountId || deployment.project.clientAccountId !== session.clientAccountId) {
      // Never distinguish "exists but not yours" from "does not exist".
      throw new WorkloadServiceError("NOT_FOUND");
    }
  }
  ensureCan(session, scope === "ADMIN" ? "workload.edit" : "workload.edit");

  const latest = await prisma.deploymentRevision.findFirst({
    where: { deploymentId },
    orderBy: { revisionNumber: "desc" }
  });
  if (!latest) throw new WorkloadServiceError("NO_REVISION");

  return { deployment, latest };
}

function servicesOf(composeSource: string): Record<string, Record<string, unknown>> {
  try {
    const root = parse(composeSource) as { services?: Record<string, Record<string, unknown>> };
    return root?.services ?? {};
  } catch {
    return {};
  }
}

/**
 * Read-only impact preview for removing a service from a managed workload.
 * Nothing is written; nothing is deployed.
 */
export async function previewServiceRemoval(input: {
  deploymentId: string;
  serviceName: string;
  session: AuthSession;
  scope: Scope;
}): Promise<ServiceRemovalImpact> {
  const { deployment, latest } = await loadContext(input.deploymentId, input.session, input.scope);

  const form = parseComposeToForm(latest.composeSource, latest.secretReferences);
  const target = form.services.find((s) => s.name.trim() === input.serviceName);
  if (!target) throw new WorkloadServiceError("SERVICE_NOT_FOUND");

  const remaining = form.services.filter((s) => s.name.trim() !== input.serviceName);

  // Containers currently attributable to this service on this node.
  const containers = await prisma.container.findMany({
    where: {
      nodeId: deployment.project.nodeId,
      composeProject: deployment.composeProjectName,
      composeService: input.serviceName,
      isActive: true
    },
    select: { dockerName: true, dockerContainerId: true, image: true }
  });

  const targetNetworks = new Set(target.networks.map((n) => n.name.trim()).filter(Boolean));
  const remainingNetworks = new Set(
    remaining.flatMap((s) => s.networks.map((n) => n.name.trim()).filter(Boolean))
  );
  const networksNoLongerUsed = Array.from(targetNetworks).filter((n) => !remainingNetworks.has(n)).sort();
  const networksRetained = Array.from(targetNetworks).filter((n) => remainingNetworks.has(n)).sort();

  const volumesRetained = target.volumes
    .filter((v) => v.kind === "volume" && v.source.trim())
    .map((v) => v.source.trim())
    .sort();

  const secretRefRe = /\$\{([A-Za-z_][A-Za-z0-9_]{0,127})\}/g;
  const secretsIn = (svcNames: typeof form.services): Set<string> => {
    const found = new Set<string>();
    for (const s of svcNames) {
      for (const e of s.environment) {
        for (const m of e.value.matchAll(secretRefRe)) {
          if (latest.secretReferences.includes(m[1])) found.add(m[1]);
        }
      }
    }
    return found;
  };
  const targetSecrets = secretsIn([target]);
  const remainingSecrets = secretsIn(remaining);
  const secretsNoLongerReferenced = Array.from(targetSecrets).filter((k) => !remainingSecrets.has(k)).sort();
  const secretsRetained = Array.from(targetSecrets).filter((k) => remainingSecrets.has(k)).sort();

  return {
    deploymentId: deployment.id,
    serviceName: input.serviceName,
    containersRemoved: containers,
    networksNoLongerUsed,
    networksRetained,
    volumesRetained,
    secretsNoLongerReferenced,
    secretsRetained,
    remainingServices: remaining.map((s) => s.name.trim()),
    removesLastService: remaining.length === 0
  };
}

export type RemoveServiceResult =
  | { status: "revision_created"; revisionId: string; revisionNumber: number; impact: ServiceRemovalImpact }
  | { status: "invalid"; composeErrors: string[]; impact: ServiceRemovalImpact }
  | { status: "ack_required"; highRiskFindings: unknown[]; impact: ServiceRemovalImpact };

/**
 * Remove a service from the workload definition by authoring a NEW REVISION
 * through the standard `createRevision` path (full node validation + security
 * analysis). Nothing is deployed: the caller must generate a plan and confirm.
 */
export async function removeServiceFromWorkload(input: {
  deploymentId: string;
  serviceName: string;
  session: AuthSession;
  scope: Scope;
  sourceIp?: string | null;
}): Promise<RemoveServiceResult> {
  const impact = await previewServiceRemoval(input);
  if (impact.removesLastService) {
    throw new WorkloadServiceError("LAST_SERVICE");
  }

  const { latest } = await loadContext(input.deploymentId, input.session, input.scope);
  const form = parseComposeToForm(latest.composeSource, latest.secretReferences);
  const next = { ...form, services: form.services.filter((s) => s.name.trim() !== input.serviceName) };
  const compose = serializeForm(next);

  // Sanity: the service must actually be gone and the rest untouched.
  const before = servicesOf(latest.composeSource);
  const after = servicesOf(compose);
  if (input.serviceName in after) throw new WorkloadServiceError("REMOVAL_FAILED");
  for (const name of Object.keys(before)) {
    if (name === input.serviceName) continue;
    if (!(name in after)) throw new WorkloadServiceError("REMOVAL_WOULD_DROP_OTHER_SERVICE");
  }

  const result = await createRevision({
    deploymentId: input.deploymentId,
    compose,
    environment: (latest.environmentSnapshot as Record<string, string>) ?? {},
    secretReferences: latest.secretReferences,
    acknowledgedFindings: [],
    deployNote: `Remove service "${input.serviceName}"`,
    policy: input.scope,
    actor: input.session,
    sourceIp: input.sourceIp ?? null
  });

  if (result.status === "created") {
    return { status: "revision_created", revisionId: result.revisionId, revisionNumber: result.revisionNumber, impact };
  }
  if (result.status === "ack_required") {
    return { status: "ack_required", highRiskFindings: result.highRiskFindings, impact };
  }
  if (result.status === "invalid") {
    return { status: "invalid", composeErrors: result.composeErrors, impact };
  }
  throw new WorkloadServiceError(result.status.toUpperCase());
}
