import crypto from "node:crypto";

/**
 * Agent-side request signature verification + replay protection.
 * Mirrors server/security/agent-signing.ts (same canonical string format).
 */

export const SIGNATURE_TIMESTAMP_WINDOW_SECONDS = 300;

export type SignedRequestFields = {
  method: string;
  path: string;
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

export function verifyRequestSignature(
  secret: string,
  fields: SignedRequestFields,
  signature: string
): boolean {
  const expected = crypto
    .createHmac("sha256", secret)
    .update(buildSignatureString(fields))
    .digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function withinTimestampWindow(timestamp: number, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  return Math.abs(nowSeconds - timestamp) <= SIGNATURE_TIMESTAMP_WINDOW_SECONDS;
}

export class NonceCache {
  private readonly seen = new Map<string, number>();
  private readonly maxEntries: number;
  private readonly ttlSeconds: number;

  constructor(maxEntries = 10_000, ttlSeconds = SIGNATURE_TIMESTAMP_WINDOW_SECONDS * 2) {
    this.maxEntries = maxEntries;
    this.ttlSeconds = ttlSeconds;
  }

  checkAndRecord(nonce: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
    this.prune(nowSeconds);
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, nowSeconds);
    if (this.seen.size > this.maxEntries) {
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
