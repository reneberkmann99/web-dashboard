import https from "node:https";
import http from "node:http";
import crypto from "node:crypto";
import type { Node } from "@prisma/client";
import { prisma } from "@/server/db";
import { readCaCertPem, nodeIdentity, caExists } from "@/server/security/agent-pki";
import { decryptSecret } from "@/server/security/crypto";

/**
 * Verified HTTPS transport to node agents (Phase 6B.1).
 *
 * SECURITY CONTRACT — every secret-bearing / managed-mutation request MUST go
 * through `secureFetch`, which:
 *   1. refuses any non-https destination (fails BEFORE network I/O, so a secret
 *      body is never written to a plaintext socket),
 *   2. validates the chain against the Noderaft Agent CA only (never the
 *      system trust store, and verification is never disabled),
 *   3. verifies the peer certificate's SAN equals this node's logical identity
 *      (`node-<id>.agents.hostpanel.internal`) — so another node's valid
 *      Noderaft certificate cannot impersonate this one,
 *   4. pins the peer certificate to the node's currently ACTIVE
 *      NodeAgentCertificate fingerprint (superseded/revoked certs are rejected
 *      even though they still chain to the CA).
 *
 * `Node.transportMode` is NEVER consulted here. It is a status/UX hint; this
 * function is the actual root of trust. There is no HTTP fallback path.
 */

export class SecureTransportError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "SecureTransportError";
  }
}

/** Keep-alive agent cache, keyed by node id + pinned fingerprint. */
const agentCache = new Map<string, https.Agent>();

function getKeepAliveAgent(cacheKey: string, ca: string): https.Agent {
  const existing = agentCache.get(cacheKey);
  if (existing) return existing;
  const agent = new https.Agent({
    ca,
    keepAlive: true,
    maxSockets: 8,
    // Explicitly enabled; never disabled anywhere in this codebase.
    rejectUnauthorized: true
  });
  agentCache.set(cacheKey, agent);
  return agent;
}

/** Drop cached sockets for a node (e.g. after certificate rotation). */
export function invalidateSecureAgent(nodeId: string): void {
  for (const key of Array.from(agentCache.keys())) {
    if (key.startsWith(`${nodeId}:`)) {
      agentCache.get(key)?.destroy();
      agentCache.delete(key);
    }
  }
}

export type ActiveCertificate = {
  id: string;
  fingerprintSha256: string;
  serialNumber: string;
  subjectIdentity: string;
  notBefore: Date;
  notAfter: Date;
};

export async function getActiveCertificate(nodeId: string): Promise<ActiveCertificate | null> {
  const cert = await prisma.nodeAgentCertificate.findFirst({
    where: { nodeId, status: "ACTIVE" },
    orderBy: { issuedAt: "desc" },
    select: {
      id: true,
      fingerprintSha256: true,
      serialNumber: true,
      subjectIdentity: true,
      notBefore: true,
      notAfter: true
    }
  });
  return cert;
}

function sanDnsNames(peerCert: crypto.X509Certificate | undefined, raw: { subjectaltname?: string }): string[] {
  const san = raw.subjectaltname ?? "";
  return san
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("DNS:"))
    .map((s) => s.slice(4));
}

export type SecureFetchOptions = {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** Override the pinned certificate (used during rotation candidate checks). */
  expectedFingerprint?: string;
  /** Override the base URL (used to verify a candidate endpoint pre-activation). */
  baseUrlOverride?: string;
};

export type SecureFetchResult = {
  status: number;
  body: string;
  /** Diagnostics for audit/report — never contains secrets. */
  tls: {
    protocol: string | null;
    peerFingerprintSha256: string;
    peerSerial: string;
    identity: string;
    url: string;
  };
};

/**
 * Perform a verified HTTPS request to a node agent. Throws
 * SecureTransportError before any network I/O when the destination is not
 * HTTPS or no ACTIVE certificate exists.
 */
export async function secureFetch(node: Node, options: SecureFetchOptions): Promise<SecureFetchResult> {
  if (!caExists()) {
    throw new SecureTransportError("AGENT_CA_NOT_CONFIGURED", "Noderaft Agent CA is not configured");
  }

  const baseUrl = options.baseUrlOverride ?? node.tlsApiBaseUrl;
  if (!baseUrl) {
    throw new SecureTransportError("NO_TLS_ENDPOINT", "Node has no verified HTTPS endpoint configured");
  }

  const url = new URL(options.path, baseUrl);
  // Fail closed BEFORE any socket is opened / body is written.
  if (url.protocol !== "https:") {
    throw new SecureTransportError(
      "INSECURE_DESTINATION",
      "Refusing to send a managed-deployment request over a non-HTTPS destination"
    );
  }

  const identity = nodeIdentity(node.id);
  let expectedFingerprint = options.expectedFingerprint;
  if (!expectedFingerprint) {
    const active = await getActiveCertificate(node.id);
    if (!active) {
      throw new SecureTransportError("NO_ACTIVE_CERTIFICATE", "Node has no ACTIVE agent certificate");
    }
    const now = Date.now();
    if (active.notBefore.getTime() > now) {
      throw new SecureTransportError("CERTIFICATE_NOT_YET_VALID", "Node certificate is not yet valid");
    }
    if (active.notAfter.getTime() < now) {
      throw new SecureTransportError("CERTIFICATE_EXPIRED", "Node certificate has expired");
    }
    expectedFingerprint = active.fingerprintSha256;
  }

  const ca = readCaCertPem();
  const agent = getKeepAliveAgent(`${node.id}:${expectedFingerprint}`, ca);
  const timeoutMs = options.timeoutMs ?? Number(process.env.NODE_AGENT_TIMEOUT_MS ?? 15000);

  return new Promise<SecureFetchResult>((resolve, reject) => {
    const req = https.request(
      {
        host: url.hostname,
        port: url.port ? Number(url.port) : 443,
        path: url.pathname + url.search,
        method: options.method,
        headers: {
          ...(options.headers ?? {}),
          ...(options.body !== undefined ? { "Content-Length": Buffer.byteLength(options.body).toString() } : {})
        },
        agent,
        // Verify the cert against the Noderaft CA using the LOGICAL identity,
        // not the connection host — so a node's IP/hostname can change freely.
        servername: identity,
        rejectUnauthorized: true,
        checkServerIdentity: (_host, peerCert) => {
          const names = sanDnsNames(undefined, peerCert as unknown as { subjectaltname?: string });
          if (!names.includes(identity)) {
            return new Error(
              `agent certificate identity mismatch: expected SAN ${identity}, got ${names.join(",") || "<none>"}`
            );
          }
          const fp = (peerCert.fingerprint256 ?? "").replace(/:/g, "").toLowerCase();
          if (fp !== expectedFingerprint) {
            return new Error("agent certificate is not the currently accepted certificate for this node");
          }
          return undefined;
        }
      },
      (res) => {
        // Capture TLS peer details IMMEDIATELY: with keep-alive the socket may
        // be detached by the time 'end' fires.
        const sock = res.socket as unknown as {
          getPeerCertificate?: (d?: boolean) => { fingerprint256?: string; serialNumber?: string };
          getProtocol?: () => string | null;
        } | null;
        const peer = sock?.getPeerCertificate?.() ?? {};
        const protocol = sock?.getProtocol?.() ?? null;

        let data = "";
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) {
            req.destroy(new Error("response too large"));
            return;
          }
          data += chunk.toString();
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: data,
            tls: {
              protocol,
              peerFingerprintSha256: (peer.fingerprint256 ?? "").replace(/:/g, "").toLowerCase(),
              peerSerial: (peer.serialNumber ?? "").toLowerCase().replace(/^0+/, ""),
              identity,
              url: url.toString()
            }
          });
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new SecureTransportError("TLS_TIMEOUT", "Secure agent request timed out"));
    });
    req.on("error", (err) => {
      reject(
        err instanceof SecureTransportError
          ? err
          : new SecureTransportError("TLS_REQUEST_FAILED", err.message)
      );
    });
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

/**
 * Live verification of a node's HTTPS endpoint: performs a real verified
 * request to `/health` and confirms the peer certificate matches the expected
 * (candidate or active) fingerprint. Only after this may a node be recorded
 * TLS_VERIFIED.
 */
export async function verifyNodeTlsEndpoint(
  node: Node,
  options?: { baseUrlOverride?: string; expectedFingerprint?: string }
): Promise<{ ok: true; tls: SecureFetchResult["tls"] } | { ok: false; code: string; message: string }> {
  try {
    // /health is behind the agent key auth; include the decrypted per-node key.
    const result = await secureFetch(node, {
      method: "GET",
      path: "/health",
      headers: { "x-agent-key": decryptSecret(node.apiKeyEncrypted) },
      timeoutMs: 10000,
      baseUrlOverride: options?.baseUrlOverride,
      expectedFingerprint: options?.expectedFingerprint
    });
    if (result.status !== 200) {
      return { ok: false, code: "UNEXPECTED_STATUS", message: `agent /health returned ${result.status}` };
    }
    return { ok: true, tls: result.tls };
  } catch (error) {
    if (error instanceof SecureTransportError) {
      return { ok: false, code: error.code, message: error.message };
    }
    return { ok: false, code: "TLS_VERIFICATION_FAILED", message: error instanceof Error ? error.message : "unknown" };
  }
}

/** Unused HTTP import guard: legacy transport lives in the existing client. */
void http;
