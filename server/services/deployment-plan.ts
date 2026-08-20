import crypto from "node:crypto";
import { parse } from "yaml";
import { prisma } from "@/server/db";

/**
 * Deployment plan engine (Phase 6B.2).
 *
 * Generates a human + machine readable, NON-MUTATING plan for deploying a
 * candidate revision. Never pulls images, never mutates Docker, never changes
 * the database. Compose remains the authority for recreation decisions — where
 * Noderaft cannot prove a recreation with `docker compose` dry-run, the plan
 * marks the service PREDICTED.
 */

export type PlanAction = "CREATE" | "RECREATE" | "UNCHANGED" | "REMOVE_CANDIDATE";
export type Certainty = "CONFIRMED" | "PREDICTED" | "UNKNOWN";

export type PlanService = {
  serviceName: string;
  action: PlanAction;
  changes: string[];
  certainty: Certainty;
};

export type PlanSecretChange = {
  key: string;
  currentVersionNumber: number | null;
  targetVersionNumber: number | null;
  changed: boolean;
  missing: boolean;
};

export type DeploymentPlan = {
  deploymentId: string;
  revisionId: string;
  fromRevisionNumber: number | null;
  toRevisionNumber: number;
  services: PlanService[];
  secretChanges: PlanSecretChange[];
  images: { serviceName: string; imageRef: string | null; digestKnown: false }[];
  networks: { name: string; action: "CREATE" | "UNCHANGED" }[];
  volumes: { name: string; action: "CREATE" | "UNCHANGED" }[];
  summary: {
    create: number;
    recreate: number;
    unchanged: number;
    removeCandidates: number;
    volumesRemoved: number;
    networksRemoved: number;
  };
  planHash: string;
};

type ParsedCompose = {
  services: Record<string, Record<string, unknown>>;
  networks: Record<string, unknown>;
  volumes: Record<string, unknown>;
};

function parseCompose(canonical: string | null): ParsedCompose {
  if (!canonical) return { services: {}, networks: {}, volumes: {} };
  try {
    const root = parse(canonical) as Record<string, unknown>;
    return {
      services: (root.services as Record<string, Record<string, unknown>>) ?? {},
      networks: (root.networks as Record<string, unknown>) ?? {},
      volumes: (root.volumes as Record<string, unknown>) ?? {}
    };
  } catch {
    return { services: {}, networks: {}, volumes: {} };
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[k] = (value as Record<string, unknown>)[k];
  }
  return JSON.stringify(sorted);
}

function diffServiceChanges(
  name: string,
  current: Record<string, unknown>,
  candidate: Record<string, unknown>
): string[] {
  const changes: string[] = [];
  if ((current.image ?? null) !== (candidate.image ?? null)) {
    changes.push(`image ${current.image ?? "<none>"} → ${candidate.image ?? "<none>"}`);
  }
  if (stableJson(current.environment ?? {}) !== stableJson(candidate.environment ?? {})) {
    changes.push("environment changed");
  }
  if (stableJson(current.ports ?? []) !== stableJson(candidate.ports ?? [])) {
    changes.push("ports changed");
  }
  if (stableJson(current.volumes ?? []) !== stableJson(candidate.volumes ?? [])) {
    changes.push("volumes changed");
  }
  if (changes.length === 0) changes.push("configuration changed");
  return changes;
}

/**
 * Deterministic plan token binding the plan to the exact state it was computed
 * from. A deploy request must carry this hash; at execution start it is
 * recomputed and compared — any change in revision content, secret versions, or
 * release/runtime fingerprint yields PLAN_STALE.
 */
export function computePlanHash(input: {
  deploymentId: string;
  revisionId: string;
  revisionContentSha256: string;
  currentReleaseId: string | null;
  secretVersionNumbers: Record<string, number | null>;
}): string {
  const payload = JSON.stringify({
    deploymentId: input.deploymentId,
    revisionId: input.revisionId,
    revisionContentSha256: input.revisionContentSha256,
    currentReleaseId: input.currentReleaseId,
    secretVersionNumbers: Object.fromEntries(
      Object.entries(input.secretVersionNumbers).sort(([a], [b]) => a.localeCompare(b))
    )
  });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

export async function resolveLatestSecretVersions(
  deploymentId: string,
  keys: string[]
): Promise<Map<string, { secretId: string; versionId: string | null; versionNumber: number | null }>> {
  if (keys.length === 0) return new Map();
  const secrets = await prisma.secret.findMany({
    where: { deploymentId, key: { in: keys }, isActive: true },
    include: {
      versions: { orderBy: { versionNumber: "desc" }, take: 1, select: { id: true, versionNumber: true } }
    }
  });
  const result = new Map<string, { secretId: string; versionId: string | null; versionNumber: number | null }>();
  for (const s of secrets) {
    const latest = s.versions[0] ?? null;
    result.set(s.key, { secretId: s.id, versionId: latest?.id ?? null, versionNumber: latest?.versionNumber ?? null });
  }
  // Keys with no Secret row (declared but never created) map to null version.
  for (const k of keys) {
    if (!result.has(k)) result.set(k, { secretId: "", versionId: null, versionNumber: null });
  }
  return result;
}

export async function getLatestRevisionId(deploymentId: string): Promise<string | null> {
  const latest = await prisma.deploymentRevision.findFirst({
    where: { deploymentId },
    orderBy: { revisionNumber: "desc" },
    select: { id: true }
  });
  return latest?.id ?? null;
}

/** Derive service -> imageRef from a normalized compose canonical (no Docker call). */
export function deriveImageRefs(composeCanonical: string): { serviceName: string; imageRef: string }[] {
  const parsed = parseCompose(composeCanonical);
  return Object.entries(parsed.services)
    .map(([serviceName, svc]) => ({ serviceName, imageRef: typeof svc.image === "string" ? svc.image : "" }))
    .filter((i) => i.imageRef.length > 0)
    .sort((a, b) => a.serviceName.localeCompare(b.serviceName));
}

export async function generateDeploymentPlan(input: {
  deploymentId: string;
  revisionId: string;
}): Promise<DeploymentPlan | null> {
  const deployment = await prisma.deployment.findUnique({
    where: { id: input.deploymentId }
  });
  if (!deployment) return null;

  const revision = await prisma.deploymentRevision.findFirst({
    where: { id: input.revisionId, deploymentId: deployment.id }
  });
  if (!revision) return null;

  const currentRelease = deployment.currentReleaseId
    ? await prisma.deploymentRelease.findUnique({
        where: { id: deployment.currentReleaseId },
        include: {
          revision: { select: { revisionNumber: true, composeCanonical: true } },
          secrets: true
        }
      })
    : null;

  const candidate = parseCompose(revision.composeCanonical);
  const current = parseCompose(currentRelease?.revision.composeCanonical ?? null);

  // Service diff.
  const allServiceNames = new Set([...Object.keys(current.services), ...Object.keys(candidate.services)]);
  const services: PlanService[] = [];
  for (const name of Array.from(allServiceNames).sort()) {
    const inCurrent = name in current.services;
    const inCandidate = name in candidate.services;
    if (inCurrent && inCandidate) {
      const changed = stableJson(current.services[name]) !== stableJson(candidate.services[name]);
      services.push({
        serviceName: name,
        action: changed ? "RECREATE" : "UNCHANGED",
        changes: changed ? diffServiceChanges(name, current.services[name], candidate.services[name]) : [],
        certainty: changed ? "PREDICTED" : "CONFIRMED"
      });
    } else if (inCandidate && !inCurrent) {
      services.push({ serviceName: name, action: "CREATE", changes: ["new service"], certainty: "CONFIRMED" });
    } else {
      services.push({
        serviceName: name,
        action: "REMOVE_CANDIDATE",
        changes: ["service removed from definition; will be reported, not deleted"],
        certainty: "PREDICTED"
      });
    }
  }

  // Secret version changes (current release snapshot vs latest).
  const latestSecrets = await resolveLatestSecretVersions(deployment.id, revision.secretReferences);
  const currentSecretVersionNumbers = new Map(
    (currentRelease?.secrets ?? []).map((s) => [s.key, s.versionNumber])
  );
  const secretChanges: PlanSecretChange[] = [];
  const secretVersionNumbers: Record<string, number | null> = {};
  for (const key of [...revision.secretReferences].sort()) {
    const latest = latestSecrets.get(key);
    const latestVersionNumber = latest?.versionNumber ?? null;
    const currentVersionNumber = currentSecretVersionNumbers.get(key) ?? null;
    secretVersionNumbers[key] = latestVersionNumber;
    secretChanges.push({
      key,
      currentVersionNumber,
      targetVersionNumber: latestVersionNumber,
      changed: currentVersionNumber !== latestVersionNumber,
      missing: latestVersionNumber === null
    });
  }

  // Image snapshot placeholders (digest unknown until pull).
  const images = Object.entries(candidate.services)
    .map(([serviceName, svc]) => ({
      serviceName,
      imageRef: typeof svc.image === "string" ? svc.image : null,
      digestKnown: false as const
    }))
    .sort((a, b) => a.serviceName.localeCompare(b.serviceName));

  // Network/volume safety: CREATE or UNCHANGED only; never REMOVE.
  const networks = Object.keys(candidate.networks)
    .sort()
    .map((name) => ({ name, action: (name in current.networks ? "UNCHANGED" : "CREATE") as "CREATE" | "UNCHANGED" }));
  const volumes = Object.keys(candidate.volumes)
    .sort()
    .map((name) => ({ name, action: (name in current.volumes ? "UNCHANGED" : "CREATE") as "CREATE" | "UNCHANGED" }));

  const summary = {
    create: services.filter((s) => s.action === "CREATE").length,
    recreate: services.filter((s) => s.action === "RECREATE").length,
    unchanged: services.filter((s) => s.action === "UNCHANGED").length,
    removeCandidates: services.filter((s) => s.action === "REMOVE_CANDIDATE").length,
    volumesRemoved: 0,
    networksRemoved: 0
  };

  const planHash = computePlanHash({
    deploymentId: deployment.id,
    revisionId: revision.id,
    revisionContentSha256: revision.contentSha256,
    currentReleaseId: deployment.currentReleaseId,
    secretVersionNumbers
  });

  return {
    deploymentId: deployment.id,
    revisionId: revision.id,
    fromRevisionNumber: currentRelease?.revision.revisionNumber ?? null,
    toRevisionNumber: revision.revisionNumber,
    services,
    secretChanges,
    images,
    networks,
    volumes,
    summary,
    planHash
  };
}

/**
 * Recompute the plan hash from the CURRENT database state (for stale-plan
 * detection at deploy/rollback time). Returns null if the deployment/revision
 * no longer exists.
 */
export async function recomputePlanHash(
  deploymentId: string,
  revisionId: string
): Promise<string | null> {
  const deployment = await prisma.deployment.findUnique({ where: { id: deploymentId } });
  const revision = await prisma.deploymentRevision.findFirst({
    where: { id: revisionId, deploymentId }
  });
  if (!deployment || !revision) return null;

  const latest = await resolveLatestSecretVersions(deploymentId, revision.secretReferences);
  const secretVersionNumbers: Record<string, number | null> = {};
  for (const [k, v] of latest) secretVersionNumbers[k] = v.versionNumber;

  return computePlanHash({
    deploymentId,
    revisionId,
    revisionContentSha256: revision.contentSha256,
    currentReleaseId: deployment.currentReleaseId,
    secretVersionNumbers
  });
}
