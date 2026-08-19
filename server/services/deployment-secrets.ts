import { prisma } from "@/server/db";
import { encryptSecret, isEncryptionKeyConfigured } from "@/server/security/crypto";
import { logAuditEvent } from "@/server/audit";
import { parse } from "yaml";
import type { AuthSession } from "@/server/auth/session";

/**
 * Deployment secret management (ADMIN-only; enforced at the route layer).
 *
 * Guarantees:
 *  - Plaintext values are encrypted (AES-256-GCM, DEPLOYMENT_SECRETS_KEY) and
 *    stored only as SecretVersion.ciphertext.
 *  - Plaintext is NEVER returned by any read path (metadata only).
 *  - Plaintext is NEVER written to AuditLog — audit events reference only the
 *    secret key + version number.
 *  - Latest version == highest versionNumber (no redundant pointer).
 */

const SECRET_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SECRET_VALUE_MAX = 8192;

export class SecretKeyUnavailableError extends Error {
  constructor() {
    super("DEPLOYMENT_SECRETS_KEY_NOT_CONFIGURED");
    this.name = "SecretKeyUnavailableError";
  }
}

function assertSecretKeyConfigured(): void {
  if (!isEncryptionKeyConfigured("DEPLOYMENT_SECRETS")) {
    throw new SecretKeyUnavailableError();
  }
}

function assertValidKey(key: string): void {
  if (!SECRET_KEY_RE.test(key)) {
    throw new Error("Invalid secret key: must match /^[A-Za-z_][A-Za-z0-9_]{0,127}$/");
  }
}

function assertValidValue(value: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Secret value must be a non-empty string");
  }
  if (value.length > SECRET_VALUE_MAX) {
    throw new Error(`Secret value must be at most ${SECRET_VALUE_MAX} characters`);
  }
}

export type SecretMetadataView = {
  id: string;
  key: string;
  isActive: boolean;
  latestVersion: { versionNumber: number; createdAt: string; createdBy: string | null } | null;
  createdAt: string;
  /** Number of services in the LATEST revision whose environment uses this secret. */
  usedByServices: number;
  /** Service names in the LATEST revision whose environment uses this secret. */
  usedByServiceNames: string[];
};

function toSecretMetadata(secret: {
  id: string;
  key: string;
  isActive: boolean;
  createdAt: Date;
  versions: { versionNumber: number; createdAt: Date; createdBy: { email: string } | null }[];
}): SecretMetadataView {
  const latest = secret.versions[0] ?? null;
  return {
    id: secret.id,
    key: secret.key,
    isActive: secret.isActive,
    latestVersion: latest
      ? {
          versionNumber: latest.versionNumber,
          createdAt: latest.createdAt.toISOString(),
          createdBy: latest.createdBy?.email ?? null
        }
      : null,
    createdAt: secret.createdAt.toISOString(),
    usedByServices: 0, // filled in by listSecrets after computing usage across services
    usedByServiceNames: []
  };
}

/**
 * Count which services in the LATEST revision's canonical config reference
 * each secret key (deterministic sentinel inside services.*.environment).
 * Pure read of the stored canonical — never Docker, never plaintext.
 */
function secretUsageByService(
  composeCanonical: string | null,
  keys: string[]
): Map<string, { count: number; names: string[] }> {
  const usage = new Map<string, { count: number; names: string[] }>(keys.map((k) => [k, { count: 0, names: [] }]));
  if (!composeCanonical || keys.length === 0) return usage;
  try {
    const root = parse(composeCanonical) as { services?: Record<string, { environment?: unknown }> };
    const services = root?.services ?? {};
    for (const [serviceName, service] of Object.entries(services)) {
      const env = service?.environment;
      if (env == null) continue;
      const values: string[] = Array.isArray(env)
        ? env.map((e) => String(e))
        : Object.values(env as Record<string, unknown>).map((v) => String(v));
      for (const key of keys) {
        const sentinel = `__HOSTPANEL_SECRET_${key}__`;
        if (values.some((v) => v.includes(sentinel))) {
          const entry = usage.get(key) ?? { count: 0, names: [] };
          entry.count += 1;
          entry.names.push(serviceName);
          usage.set(key, entry);
        }
      }
    }
  } catch {
    // Unparseable canonical → usage stays 0; the deployment engine already
    // validated it before persisting, so this is purely defensive.
  }
  return usage;
}

export async function listSecrets(deploymentId: string): Promise<SecretMetadataView[]> {
  const secrets = await prisma.secret.findMany({
    where: { deploymentId },
    orderBy: { key: "asc" },
    include: {
      versions: {
        orderBy: { versionNumber: "desc" },
        take: 1,
        include: { createdBy: { select: { email: true } } }
      }
    }
  });
  const latestRevision = await prisma.deploymentRevision.findFirst({
    where: { deploymentId },
    orderBy: { revisionNumber: "desc" },
    select: { composeCanonical: true }
  });
  const usage = secretUsageByService(latestRevision?.composeCanonical ?? null, secrets.map((s) => s.key));
  return secrets.map((s) => {
    const u = usage.get(s.key) ?? { count: 0, names: [] };
    return { ...toSecretMetadata(s), usedByServices: u.count, usedByServiceNames: u.names };
  });
}

/**
 * Create a secret with its first version. Returns metadata (never the value).
 */
export async function createSecret(input: {
  deploymentId: string;
  key: string;
  value: string;
  actor: AuthSession;
  sourceIp?: string | null;
}): Promise<SecretMetadataView> {
  assertSecretKeyConfigured();
  assertValidKey(input.key);
  assertValidValue(input.value);

  const deployment = await prisma.deployment.findUnique({
    where: { id: input.deploymentId },
    select: { id: true }
  });
  if (!deployment) throw new Error("NOT_FOUND");

  const ciphertext = encryptSecret(input.value, "DEPLOYMENT_SECRETS");

  const secret = await prisma.secret.create({
    data: {
      deploymentId: input.deploymentId,
      key: input.key,
      isActive: true,
      versions: {
        create: {
          versionNumber: 1,
          ciphertext,
          createdById: input.actor.userId
        }
      }
    },
    include: {
      versions: {
        orderBy: { versionNumber: "desc" },
        take: 1,
        include: { createdBy: { select: { email: true } } }
      }
    }
  });

  await logAuditEvent({
    actorUserId: input.actor.userId,
    actorEmail: input.actor.email,
    actorRole: input.actor.role,
    action: "SECRET_CREATED",
    targetType: "SECRET",
    targetId: secret.id,
    metadata: { deploymentId: input.deploymentId, key: input.key },
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null
  });

  return toSecretMetadata(secret);
}

/**
 * Rotate a secret by appending a new version (latest = highest versionNumber).
 * The old versions are retained; the value is never returned.
 */
export async function rotateSecret(input: {
  deploymentId: string;
  secretId: string;
  value: string;
  actor: AuthSession;
  sourceIp?: string | null;
}): Promise<{ id: string; versionNumber: number }> {
  assertSecretKeyConfigured();
  assertValidValue(input.value);

  const secret = await prisma.secret.findFirst({
    where: { id: input.secretId, deploymentId: input.deploymentId }
  });
  if (!secret) throw new Error("NOT_FOUND");

  const ciphertext = encryptSecret(input.value, "DEPLOYMENT_SECRETS");

  // Allocate the next version number under the (secretId, versionNumber) unique
  // constraint — a concurrent rotate races and fails on P2002, which we surface
  // rather than silently overwriting.
  const latest = await prisma.secretVersion.findFirst({
    where: { secretId: secret.id },
    orderBy: { versionNumber: "desc" },
    select: { versionNumber: true }
  });
  const nextVersion = (latest?.versionNumber ?? 0) + 1;

  const version = await prisma.secretVersion.create({
    data: {
      secretId: secret.id,
      versionNumber: nextVersion,
      ciphertext,
      createdById: input.actor.userId
    }
  });

  await logAuditEvent({
    actorUserId: input.actor.userId,
    actorEmail: input.actor.email,
    actorRole: input.actor.role,
    action: "SECRET_ROTATED",
    targetType: "SECRET",
    targetId: secret.id,
    metadata: { deploymentId: secret.deploymentId, key: secret.key, versionNumber: nextVersion },
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null
  });

  return { id: secret.id, versionNumber: nextVersion };
}

/**
 * Soft-disable (or re-enable) a secret. Disabling never deletes versions.
 */
export async function setSecretActive(input: {
  deploymentId: string;
  secretId: string;
  isActive: boolean;
  actor: AuthSession;
  sourceIp?: string | null;
}): Promise<SecretMetadataView> {
  const secret = await prisma.secret.findFirst({
    where: { id: input.secretId, deploymentId: input.deploymentId },
    include: {
      versions: {
        orderBy: { versionNumber: "desc" },
        take: 1,
        include: { createdBy: { select: { email: true } } }
      }
    }
  });
  if (!secret) throw new Error("NOT_FOUND");

  const updated = await prisma.secret.update({
    where: { id: secret.id },
    data: { isActive: input.isActive },
    include: {
      versions: {
        orderBy: { versionNumber: "desc" },
        take: 1,
        include: { createdBy: { select: { email: true } } }
      }
    }
  });

  await logAuditEvent({
    actorUserId: input.actor.userId,
    actorEmail: input.actor.email,
    actorRole: input.actor.role,
    action: input.isActive ? "SECRET_ENABLED" : "SECRET_DISABLED",
    targetType: "SECRET",
    targetId: secret.id,
    metadata: { deploymentId: secret.deploymentId, key: secret.key },
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null
  });

  return toSecretMetadata(updated);
}

/** Version metadata history for one secret (never ciphertext). */
export async function listSecretVersions(
  deploymentId: string,
  secretId: string
): Promise<{ id: string; versionNumber: number; createdAt: string; createdBy: string | null }[] | null> {
  const secret = await prisma.secret.findFirst({
    where: { id: secretId, deploymentId },
    select: { id: true }
  });
  if (!secret) return null;
  const versions = await prisma.secretVersion.findMany({
    where: { secretId },
    orderBy: { versionNumber: "desc" },
    select: { id: true, versionNumber: true, createdAt: true, createdBy: { select: { email: true } } }
  });
  return versions.map((v) => ({
    id: v.id,
    versionNumber: v.versionNumber,
    createdAt: v.createdAt.toISOString(),
    createdBy: v.createdBy?.email ?? null
  }));
}
