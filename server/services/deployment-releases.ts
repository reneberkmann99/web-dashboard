import { prisma } from "@/server/db";

/**
 * Release history for managed deployments (Phase 6C).
 *
 * Releases are IMMUTABLE and append-only: display numbers are computed as the
 * 1-based position by creation order (stable because rows are never deleted).
 * Never exposes secret plaintext or ciphertext — only secret KEY names and
 * VERSION NUMBERS already recorded in the release snapshots.
 */

export type ReleaseImageSummary = {
  serviceName: string;
  imageRef: string;
  imageId: string | null;
  repoDigest: string | null;
};

export type ReleaseSecretSummary = {
  key: string;
  versionNumber: number;
};

export type DeploymentReleaseListItem = {
  id: string;
  displayNumber: number;
  revisionId: string;
  revisionNumber: number;
  operationId: string;
  operationType: string;
  operationState: string;
  actorEmail: string | null;
  healthVerdict: string;
  appliedAt: string;
  verifiedAt: string | null;
  /** Failure reason for degraded/failed releases (operation error). */
  failureReason: string | null;
  isCurrent: boolean;
  isLastHealthy: boolean;
  /** True when this release reused the same revision as the previous release (e.g. secret rotation). */
  sameRevisionAsPrevious: boolean;
  images: ReleaseImageSummary[];
  secrets: ReleaseSecretSummary[];
};

type ReleaseRow = {
  id: string;
  revisionId: string;
  revisionNumber: number;
  operationId: string;
  operationType: string;
  operationState: string;
  actorEmail: string | null;
  healthVerdict: string;
  appliedAt: Date | null;
  verifiedAt: Date | null;
  operationError: string | null;
  composeVersion: string | null;
  displayNumber: number;
};

export async function listDeploymentReleases(
  deploymentId: string,
  opts: { limit?: number; offset?: number } = {}
): Promise<{
  data: DeploymentReleaseListItem[];
  total: number;
  runtimeState: string;
  currentReleaseId: string | null;
  lastHealthyReleaseId: string | null;
} | null> {
  const deployment = await prisma.deployment.findUnique({
    where: { id: deploymentId },
    select: { currentReleaseId: true, lastHealthyReleaseId: true, runtimeState: true }
  });
  if (!deployment) return null;

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  // Window function for a stable, append-only display number. Prisma's typed
  // client has no window-function support, so this one query is raw SQL.
  const rows = await prisma.$queryRaw<ReleaseRow[]>`
    SELECT r.id, r."revisionId", r."healthVerdict", r."operationId", r."composeVersion",
           r."appliedAt", r."verifiedAt", r."createdAt",
           rev."revisionNumber",
           op.type AS "operationType", op.state AS "operationState",
           op."actorEmail", op.error AS "operationError",
           row_number() OVER (ORDER BY r."createdAt" ASC, r.id ASC)::int AS "displayNumber"
      FROM "DeploymentRelease" r
      JOIN "DeploymentRevision" rev ON rev.id = r."revisionId"
      JOIN "DeploymentOperation" op ON op.id = r."operationId"
     WHERE r."deploymentId" = ${deploymentId}
     ORDER BY r."createdAt" DESC, r.id DESC
     LIMIT ${limit} OFFSET ${offset}`;

  const total = await prisma.deploymentRelease.count({ where: { deploymentId } });

  const releaseIds = rows.map((r) => r.id);
  const images = releaseIds.length
    ? await prisma.deploymentReleaseImage.findMany({
        where: { releaseId: { in: releaseIds } },
        select: { releaseId: true, serviceName: true, imageRef: true, imageId: true, repoDigest: true },
        orderBy: { serviceName: "asc" }
      })
    : [];
  const secrets = releaseIds.length
    ? await prisma.deploymentReleaseSecret.findMany({
        where: { releaseId: { in: releaseIds } },
        select: { releaseId: true, key: true, versionNumber: true },
        orderBy: { key: "asc" }
      })
    : [];

  // Previous revision per release (ascending history) to flag secret-rotation
  // releases (same revision as predecessor).
  const ordered = await prisma.deploymentRelease.findMany({
    where: { deploymentId },
    select: { id: true, revisionId: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }]
  });
  const prevRevision = new Map<string, string>();
  for (let i = 0; i < ordered.length; i++) {
    prevRevision.set(ordered[i].id, i > 0 ? ordered[i - 1].revisionId : "");
  }

  const data: DeploymentReleaseListItem[] = rows.map((r) => ({
    id: r.id,
    displayNumber: r.displayNumber,
    revisionId: r.revisionId,
    revisionNumber: r.revisionNumber,
    operationId: r.operationId,
    operationType: r.operationType,
    operationState: r.operationState,
    actorEmail: r.actorEmail,
    healthVerdict: r.healthVerdict,
    appliedAt: r.appliedAt?.toISOString() ?? "",
    verifiedAt: r.verifiedAt?.toISOString() ?? null,
    failureReason: r.operationError,
    isCurrent: r.id === deployment.currentReleaseId,
    isLastHealthy: r.id === deployment.lastHealthyReleaseId,
    sameRevisionAsPrevious: prevRevision.get(r.id) === r.revisionId,
    images: images
      .filter((i) => i.releaseId === r.id)
      .map((i) => ({ serviceName: i.serviceName, imageRef: i.imageRef, imageId: i.imageId, repoDigest: i.repoDigest })),
    secrets: secrets.filter((s) => s.releaseId === r.id).map((s) => ({ key: s.key, versionNumber: s.versionNumber }))
  }));

  return {
    data,
    total,
    runtimeState: deployment.runtimeState,
    currentReleaseId: deployment.currentReleaseId,
    lastHealthyReleaseId: deployment.lastHealthyReleaseId
  };
}

export type DeploymentReleaseDetail = DeploymentReleaseListItem & {
  composeVersion: string | null;
  revisionCreatedAt: string;
  revisionCreatedBy: string | null;
  deployNote: string | null;
  deploymentId: string;
  composeProjectName: string;
  deploymentRuntimeState: string;
  /** Terminal result captured on the operation (verification, convergence, health). */
  operationResult: {
    verifyVerdict: string | null;
    runtimeConverged: boolean | null;
    health: string | null;
    planHash: string | null;
    applyError: string | null;
    cancelled: boolean | null;
    recovered: boolean | null;
  };
  /** Secret versions rotated since the previous release (empty = no rotation). */
  rotatedSecretKeys: string[];
  previousRelease: { id: string; displayNumber: number } | null;
};

export async function getDeploymentReleaseDetail(
  deploymentId: string,
  releaseId: string
): Promise<DeploymentReleaseDetail | null> {
  const list = await listDeploymentReleases(deploymentId, { limit: 200 });
  if (!list) return null;
  const item = list.data.find((r) => r.id === releaseId);
  if (!item) return null;

  const release = await prisma.deploymentRelease.findUnique({
    where: { id: releaseId },
    include: {
      revision: { select: { createdAt: true, createdBy: { select: { email: true } }, deployNote: true } },
      deployment: { select: { id: true, composeProjectName: true } }
    }
  });
  if (!release) return null;

  const operation = release.operationId
    ? await prisma.deploymentOperation.findUnique({
        where: { id: release.operationId },
        select: { result: true, error: true }
      })
    : null;

  // Rotation detection: same revision as previous but secret versions changed.
  const ordered = await prisma.deploymentRelease.findMany({
    where: { deploymentId },
    select: { id: true, revisionId: true, createdAt: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }]
  });
  const idx = ordered.findIndex((r) => r.id === releaseId);
  const previous = idx > 0 ? ordered[idx - 1] : null;
  const prevSecrets = previous
    ? await prisma.deploymentReleaseSecret.findMany({ where: { releaseId: previous.id }, select: { key: true, versionNumber: true } })
    : [];
  const ownSecrets = await prisma.deploymentReleaseSecret.findMany({ where: { releaseId }, select: { key: true, versionNumber: true } });
  const rotatedSecretKeys = previous
    ? ownSecrets
        .filter((s) => {
          const prev = prevSecrets.find((p) => p.key === s.key);
          return prev !== undefined && prev.versionNumber !== s.versionNumber;
        })
        .map((s) => s.key)
    : [];

  const result = (operation?.result as Record<string, unknown> | null) ?? {};
  const verify = (result.verify ?? null) as { verdict?: string } | null;

  return {
    ...item,
    composeVersion: release.composeVersion,
    revisionCreatedAt: release.revision.createdAt.toISOString(),
    revisionCreatedBy: release.revision.createdBy?.email ?? null,
    deployNote: release.revision.deployNote,
    deploymentId: release.deployment.id,
    composeProjectName: release.deployment.composeProjectName,
    deploymentRuntimeState: list.runtimeState,
    operationResult: {
      verifyVerdict: verify?.verdict ?? null,
      runtimeConverged: typeof result.runtimeConverged === "boolean" ? result.runtimeConverged : null,
      health: typeof result.health === "string" ? result.health : null,
      planHash: typeof result.planHash === "string" ? result.planHash : null,
      applyError: typeof result.applyError === "string" ? result.applyError : null,
      cancelled: typeof result.cancelled === "boolean" ? result.cancelled : null,
      recovered: typeof result.recovered === "boolean" ? result.recovered : null
    },
    rotatedSecretKeys,
    previousRelease: previous
      ? {
          id: previous.id,
          // displayNumber is the 1-based append-only position; the immediate
          // predecessor is therefore exactly one less.
          displayNumber: item.displayNumber - 1
        }
      : null
  };
}
