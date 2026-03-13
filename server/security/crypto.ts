import crypto from "node:crypto";

/**
 * Security: AES-256-GCM encryption for node agent API keys.
 * Keys are encrypted at rest using NODE_CREDENTIALS_KEY.
 * The key must be a 64-character hex string (32 bytes).
 * Each encryption uses a unique 12-byte IV for GCM nonce.
 */

function getKey(): Buffer {
  const rawKey = process.env.NODE_CREDENTIALS_KEY;
  if (!rawKey || rawKey.length !== 64) {
    throw new Error("NODE_CREDENTIALS_KEY must be a 64-char hex string");
  }

  return Buffer.from(rawKey, "hex");
}

export function encryptSecret(value: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptSecret(payload: string): string {
  const [ivRaw, tagRaw, encryptedRaw] = payload.split(":");
  if (!ivRaw || !tagRaw || !encryptedRaw) {
    throw new Error("Invalid encrypted payload format");
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getKey(),
    Buffer.from(ivRaw, "base64")
  );
  decipher.setAuthTag(Buffer.from(tagRaw, "base64"));
  const output = Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64")),
    decipher.final()
  ]);

  return output.toString("utf8");
}
