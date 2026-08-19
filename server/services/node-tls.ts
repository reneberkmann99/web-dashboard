import crypto from "node:crypto";
import type { Node } from "@prisma/client";
import { prisma } from "@/server/db";
import { logAuditEvent } from "@/server/audit";
import { decryptSecret } from "@/server/security/crypto";
import {
  signNodeCsr,
  nodeIdentity,
  caExists,
  AGENT_CERT_LIFETIME_DAYS,
  daysUntil,
  CERT_EXPIRY_WARNING_DAYS
} from "@/server/security/agent-pki";
import { verifyNodeTlsEndpoint, invalidateSecureAgent } from "@/server/services/node-agent/secure-transport";
import type { AuthSession } from "@/server/auth/session";

/**
 * Node TLS enrollment / rotation / revocation (Phase 6B.1).
 *
 * Flow (rotation-safe):
 *   1. ADMIN issues a short-lived one-time enrollment token (existing
 *      NodeEnrollmentToken machinery, hashed at rest).
 *   2. Agent generates key + CSR locally, posts the CSR with the token.
 *   3. Control plane signs a certificate whose identity it chooses; records
 *      metadata as a CANDIDATE (status SUPERSEDED until verified).
 *   4. Control plane performs a LIVE verified-HTTPS request against the
 *      candidate; only on success does it become ACTIVE, the previous cert
 *      become SUPERSEDED, and the node become TLS_VERIFIED.
 *   5. If verification fails, the previously working certificate stays ACTIVE.
 */

const TLS_ENROLLMENT_TTL_MINUTES = 15;

export async function createTlsEnrollmentToken(input: {
  nodeId: string;
  actor: AuthSession;
  sourceIp?: string | null;
}): Promise<{ token: string; expiresAt: Date }> {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + TLS_ENROLLMENT_TTL_MINUTES * 60 * 1000);

  const created = await prisma.nodeEnrollmentToken.create({
    data: {
      tokenHash: crypto.createHash("sha256").update(rawToken).digest("hex"),
      nodeId: input.nodeId,
      createdById: input.actor.userId,
      expiresAt
    }
  });

  await logAuditEvent({
    actorUserId: input.actor.userId,
    actorEmail: input.actor.email,
    actorRole: input.actor.role,
    action: "NODE_TLS_ENROLLMENT_TOKEN_CREATED",
    targetType: "NODE",
    targetId: input.nodeId,
    // Never the token itself.
    metadata: { tokenId: created.id, expiresAt: expiresAt.toISOString(), ttlMinutes: TLS_ENROLLMENT_TTL_MINUTES },
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null
  });

  return { token: rawToken, expiresAt };
}

export type TlsEnrollResult =
  | { status: "issued"; certPem: string; caPem: string; identity: string; notAfter: Date; certificateId: string }
  | { status: "invalid_token" }
  | { status: "ca_not_configured" }
  | { status: "invalid_csr"; message: string };

/**
 * Sign an agent CSR. Consumes the one-time token. The issued certificate is
 * recorded as a candidate (SUPERSEDED) — it becomes ACTIVE only after live
 * verification, so a failed rotation can never strand a working node.
 */
export async function enrollNodeCertificate(input: {
  token: string;
  csrPem: string;
  tlsPort?: number;
  sourceIp?: string | null;
}): Promise<TlsEnrollResult> {
  if (!caExists()) return { status: "ca_not_configured" };

  const tokenHash = crypto.createHash("sha256").update(input.token).digest("hex");
  const token = await prisma.nodeEnrollmentToken.findUnique({ where: { tokenHash } });
  if (!token || token.usedAt || token.expiresAt.getTime() < Date.now() || !token.nodeId) {
    await logAuditEvent({
      action: "NODE_TLS_VERIFICATION_FAILED",
      targetType: "NODE",
      targetId: token?.nodeId ?? null,
      metadata: { reason: token ? (token.usedAt ? "token_already_used" : "token_expired") : "token_not_found" },
      result: "FAILURE",
      sourceIp: input.sourceIp ?? null
    });
    return { status: "invalid_token" };
  }

  const node = await prisma.node.findUnique({ where: { id: token.nodeId } });
  if (!node) return { status: "invalid_token" };

  let issued;
  try {
    issued = signNodeCsr({ nodeId: node.id, csrPem: input.csrPem, lifetimeDays: AGENT_CERT_LIFETIME_DAYS });
  } catch (error) {
    return { status: "invalid_csr", message: error instanceof Error ? error.message : "invalid CSR" };
  }

  // Consume the token and record certificate metadata as a candidate.
  const certificate = await prisma.$transaction(async (tx) => {
    await tx.nodeEnrollmentToken.update({ where: { id: token.id }, data: { usedAt: new Date() } });
    return tx.nodeAgentCertificate.create({
      data: {
        nodeId: node.id,
        serialNumber: issued.serialNumber,
        fingerprintSha256: issued.fingerprintSha256,
        subjectIdentity: issued.identity,
        // Candidate until live verification promotes it.
        status: "SUPERSEDED",
        notBefore: issued.notBefore,
        notAfter: issued.notAfter
      }
    });
  });

  await logAuditEvent({
    action: "NODE_CERTIFICATE_ISSUED",
    targetType: "NODE",
    targetId: node.id,
    metadata: {
      certificateId: certificate.id,
      serialNumber: issued.serialNumber,
      fingerprintSha256: issued.fingerprintSha256,
      identity: issued.identity,
      notAfter: issued.notAfter.toISOString()
    },
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null
  });

  return {
    status: "issued",
    certPem: issued.certPem,
    caPem: issued.caPem,
    identity: issued.identity,
    notAfter: issued.notAfter,
    certificateId: certificate.id
  };
}

/**
 * Live-verify a candidate certificate against the node's HTTPS endpoint and,
 * on success, promote it to ACTIVE + mark the node TLS_VERIFIED. On failure the
 * previous ACTIVE certificate and transport mode are left untouched.
 */
export async function verifyAndActivateCertificate(input: {
  nodeId: string;
  certificateId: string;
  tlsApiBaseUrl: string;
  actor?: AuthSession;
  sourceIp?: string | null;
}): Promise<{ ok: true; tls: { url: string; identity: string; peerFingerprintSha256: string } } | { ok: false; code: string; message: string }> {
  const node = await prisma.node.findUnique({ where: { id: input.nodeId } });
  if (!node) return { ok: false, code: "NODE_NOT_FOUND", message: "Node not found" };

  const candidate = await prisma.nodeAgentCertificate.findFirst({
    where: { id: input.certificateId, nodeId: input.nodeId }
  });
  if (!candidate) return { ok: false, code: "CERTIFICATE_NOT_FOUND", message: "Certificate not found" };

  invalidateSecureAgent(node.id);
  const verification = await verifyNodeTlsEndpoint(node, {
    baseUrlOverride: input.tlsApiBaseUrl,
    expectedFingerprint: candidate.fingerprintSha256
  });

  if (!verification.ok) {
    await prisma.node.update({
      where: { id: node.id },
      data: { lastTlsError: `${verification.code}: ${verification.message}`.slice(0, 500) }
    });
    await logAuditEvent({
      actorUserId: input.actor?.userId,
      actorEmail: input.actor?.email,
      actorRole: input.actor?.role,
      action: "NODE_TLS_VERIFICATION_FAILED",
      targetType: "NODE",
      targetId: node.id,
      metadata: { certificateId: candidate.id, code: verification.code },
      result: "FAILURE",
      sourceIp: input.sourceIp ?? null
    });
    return { ok: false, code: verification.code, message: verification.message };
  }

  // Promote: candidate -> ACTIVE, previous ACTIVE -> SUPERSEDED.
  await prisma.$transaction([
    prisma.nodeAgentCertificate.updateMany({
      where: { nodeId: node.id, status: "ACTIVE", NOT: { id: candidate.id } },
      data: { status: "SUPERSEDED" }
    }),
    prisma.nodeAgentCertificate.update({
      where: { id: candidate.id },
      data: { status: "ACTIVE", verifiedAt: new Date() }
    }),
    prisma.node.update({
      where: { id: node.id },
      data: {
        transportMode: "TLS_VERIFIED",
        tlsApiBaseUrl: input.tlsApiBaseUrl,
        lastTlsVerifiedAt: new Date(),
        lastTlsError: null
      }
    })
  ]);
  invalidateSecureAgent(node.id);

  await logAuditEvent({
    actorUserId: input.actor?.userId,
    actorEmail: input.actor?.email,
    actorRole: input.actor?.role,
    action: "NODE_CERTIFICATE_VERIFIED",
    targetType: "NODE",
    targetId: node.id,
    metadata: {
      certificateId: candidate.id,
      serialNumber: candidate.serialNumber,
      fingerprintSha256: candidate.fingerprintSha256,
      identity: candidate.subjectIdentity
    },
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null
  });

  return {
    ok: true,
    tls: {
      url: verification.tls.url,
      identity: verification.tls.identity,
      peerFingerprintSha256: verification.tls.peerFingerprintSha256
    }
  };
}

/** Revoke a node's active certificate; managed execution stops immediately. */
export async function revokeNodeCertificate(input: {
  nodeId: string;
  actor: AuthSession;
  sourceIp?: string | null;
}): Promise<{ revoked: number }> {
  const active = await prisma.nodeAgentCertificate.findMany({
    where: { nodeId: input.nodeId, status: "ACTIVE" },
    select: { id: true, serialNumber: true, fingerprintSha256: true }
  });

  await prisma.$transaction([
    prisma.nodeAgentCertificate.updateMany({
      where: { nodeId: input.nodeId, status: "ACTIVE" },
      data: { status: "REVOKED", revokedAt: new Date() }
    }),
    prisma.node.update({
      where: { id: input.nodeId },
      data: { transportMode: "LEGACY_HTTP", lastTlsError: "certificate revoked by administrator" }
    })
  ]);
  invalidateSecureAgent(input.nodeId);

  for (const cert of active) {
    await logAuditEvent({
      actorUserId: input.actor.userId,
      actorEmail: input.actor.email,
      actorRole: input.actor.role,
      action: "NODE_CERTIFICATE_REVOKED",
      targetType: "NODE",
      targetId: input.nodeId,
      metadata: { certificateId: cert.id, serialNumber: cert.serialNumber, fingerprintSha256: cert.fingerprintSha256 },
      result: "SUCCESS",
      sourceIp: input.sourceIp ?? null
    });
  }

  return { revoked: active.length };
}

export type NodeTlsStatus = {
  transportMode: string;
  tlsApiBaseUrl: string | null;
  lastTlsVerifiedAt: string | null;
  lastTlsError: string | null;
  caConfigured: boolean;
  identity: string;
  certificate: {
    id: string;
    serialNumber: string;
    fingerprintSha256: string;
    fingerprintShort: string;
    notBefore: string;
    notAfter: string;
    daysRemaining: number;
    status: string;
    verifiedAt: string | null;
  } | null;
};

export async function getNodeTlsStatus(nodeId: string): Promise<NodeTlsStatus | null> {
  const node = await prisma.node.findUnique({ where: { id: nodeId } });
  if (!node) return null;
  const cert = await prisma.nodeAgentCertificate.findFirst({
    where: { nodeId, status: "ACTIVE" },
    orderBy: { issuedAt: "desc" }
  });
  return {
    transportMode: node.transportMode,
    tlsApiBaseUrl: node.tlsApiBaseUrl,
    lastTlsVerifiedAt: node.lastTlsVerifiedAt?.toISOString() ?? null,
    lastTlsError: node.lastTlsError,
    caConfigured: caExists(),
    identity: nodeIdentity(nodeId),
    certificate: cert
      ? {
          id: cert.id,
          serialNumber: cert.serialNumber,
          fingerprintSha256: cert.fingerprintSha256,
          fingerprintShort: `${cert.fingerprintSha256.slice(0, 8)}…${cert.fingerprintSha256.slice(-8)}`,
          notBefore: cert.notBefore.toISOString(),
          notAfter: cert.notAfter.toISOString(),
          daysRemaining: daysUntil(cert.notAfter),
          status: cert.status,
          verifiedAt: cert.verifiedAt?.toISOString() ?? null
        }
      : null
  };
}

/** Certificate-expiry attention items (warning ≤14 days, critical when expired). */
export async function getCertificateAttentionItems(): Promise<
  Array<{ severity: "critical" | "warning"; nodeId: string; nodeName: string; detail: string }>
> {
  const certs = await prisma.nodeAgentCertificate.findMany({
    where: { status: "ACTIVE" },
    include: { node: { select: { id: true, name: true, isActive: true } } }
  });
  const items: Array<{ severity: "critical" | "warning"; nodeId: string; nodeName: string; detail: string }> = [];
  for (const cert of certs) {
    if (!cert.node.isActive) continue;
    const days = daysUntil(cert.notAfter);
    if (days < 0) {
      items.push({
        severity: "critical",
        nodeId: cert.node.id,
        nodeName: cert.node.name,
        detail: `Agent certificate expired ${Math.abs(days)} day(s) ago — managed deployment is unavailable.`
      });
    } else if (days <= CERT_EXPIRY_WARNING_DAYS) {
      items.push({
        severity: "warning",
        nodeId: cert.node.id,
        nodeName: cert.node.name,
        detail: `Agent certificate expires in ${days} day(s) — rotate secure transport.`
      });
    }
  }
  return items;
}

/** Trigger TLS enrollment on the agent (agent generates key + CSR locally). */
export async function triggerAgentTlsEnrollment(
  node: Node,
  token: string
): Promise<{ ok: boolean; tlsPort: number | null }> {
  try {
    const url = new URL("/tls/enroll", node.apiBaseUrl);
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-agent-key": decryptSecret(node.apiKeyEncrypted) },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) return { ok: false, tlsPort: null };
    const payload = (await response.json()) as { ok: boolean; tlsPort?: number };
    return { ok: payload.ok, tlsPort: payload.tlsPort ?? null };
  } catch {
    return { ok: false, tlsPort: null };
  }
}
