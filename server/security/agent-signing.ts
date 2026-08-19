import crypto from "node:crypto";

/**
 * Application-layer request signing + replay protection for high-impact managed
 * deployment MUTATION requests to the node agent.
 *
 * TLS secures transport; this layer adds per-request integrity + freshness so a
 * captured/legacy agent key cannot be replayed against a mutation endpoint.
 *
 * Signature input (canonical, newline-joined, uppercase method):
 *   METHOD\nPATH\nTIMESTAMP\nNONCE\nBODY_SHA256\nOPERATION_ID
 * signed with HMAC-SHA256 keyed by the per-node agent key.
 *
 * The agent validates: signature (constant-time), timestamp window, nonce
 * uniqueness (bounded cache), operation id, and node identity.
 */

export const SIGNATURE_TIMESTAMP_WINDOW_SECONDS = 300; // ±5 minutes

export type SignedRequestFields = {
  method: string;
  path: string;
  /** Unix seconds. */
  timestamp: number;
  nonce: string;
  bodySha256: string;
  operationId: string;
};

export function sha256Hex(data: string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function buildSignatureString(fields: SignedRequestFields): string {
  return [
    fields.method.toUpperCase(),
    fields.path,
    String(fields.timestamp),
    fields.nonce,
    fields.bodySha256,
    fields.operationId
  ].join("\n");
}

export function signRequest(secret: string, fields: SignedRequestFields): string {
  return crypto.createHmac("sha256", secret).update(buildSignatureString(fields)).digest("hex");
}

export function verifyRequestSignature(
  secret: string,
  fields: SignedRequestFields,
  signature: string
): boolean {
  const expected = signRequest(secret, fields);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function withinTimestampWindow(timestamp: number, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  const delta = Math.abs(nowSeconds - timestamp);
  return delta <= SIGNATURE_TIMESTAMP_WINDOW_SECONDS;
}

/**
 * Bounded, monotonic nonce cache. Rejects replays of a nonce within its
 * validity window; prunes expired entries so memory stays bounded.
 */
export class NonceCache {
  private readonly seen = new Map<string, number>();
  private readonly maxEntries: number;
  private readonly ttlSeconds: number;

  constructor(maxEntries = 10_000, ttlSeconds = SIGNATURE_TIMESTAMP_WINDOW_SECONDS * 2) {
    this.maxEntries = maxEntries;
    this.ttlSeconds = ttlSeconds;
  }

  /** Returns true if the nonce is fresh (not seen before) and records it. */
  checkAndRecord(nonce: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
    this.prune(nowSeconds);
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, nowSeconds);
    if (this.seen.size > this.maxEntries) {
      // Evict the oldest entry (Map preserves insertion order).
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }

  private prune(nowSeconds: number): void {
    const cutoff = nowSeconds - this.ttlSeconds;
    for (const [nonce, at] of this.seen) {
      if (at < cutoff) this.seen.delete(nonce);
    }
  }
}
