import crypto from "node:crypto";

/**
 * Security: AES-256-GCM encryption with a typed key purpose.
 *
 * Independent master keys are used, one per purpose, each supplied via the
 * environment only (never the database) and each 64 hex chars (32 bytes):
 *   - NODE_CREDENTIALS         -> NODE_CREDENTIALS_KEY         (encrypts Node.apiKeyEncrypted)
 *   - DEPLOYMENT_SECRETS       -> DEPLOYMENT_SECRETS_KEY       (encrypts SecretVersion.ciphertext)
 *   - NOTIFICATION_DESTINATIONS -> NOTIFICATION_DESTINATIONS_KEY (encrypts NotificationDestination webhook URL/auth header/signing secret)
 *   - SMTP_CREDENTIALS         -> SMTP_CREDENTIALS_KEY         (encrypts PlatformEmailSettings.passwordEncrypted)
 *
 * Each encryption uses a unique 12-byte IV; GCM auth tag is verified on
 * decrypt. A wrong/missing/malformed key fails closed (throws) rather than
 * silently producing a bad result.
 */

export type EncryptionPurpose =
  | "NODE_CREDENTIALS"
  | "DEPLOYMENT_SECRETS"
  | "NOTIFICATION_DESTINATIONS"
  | "SMTP_CREDENTIALS";

const PURPOSE_ENV: Record<EncryptionPurpose, string> = {
  NODE_CREDENTIALS: "NODE_CREDENTIALS_KEY",
  DEPLOYMENT_SECRETS: "DEPLOYMENT_SECRETS_KEY",
  NOTIFICATION_DESTINATIONS: "NOTIFICATION_DESTINATIONS_KEY",
  SMTP_CREDENTIALS: "SMTP_CREDENTIALS_KEY"
};

function getKey(purpose: EncryptionPurpose): Buffer {
  const envVar = PURPOSE_ENV[purpose];
  const rawKey = process.env[envVar];
  if (!rawKey || rawKey.length !== 64) {
    throw new Error(`${envVar} must be a 64-char hex string (32 bytes)`);
  }
  return Buffer.from(rawKey, "hex");
}

/**
 * True when the key for `purpose` is configured (64 hex chars). Used to fail
 * safely only when secret functionality is actually exercised, without
 * requiring the deployment-secrets key at process startup.
 */
export function isEncryptionKeyConfigured(purpose: EncryptionPurpose): boolean {
  const rawKey = process.env[PURPOSE_ENV[purpose]];
  return Boolean(rawKey && rawKey.length === 64);
}

export function encryptSecret(value: string, purpose: EncryptionPurpose = "NODE_CREDENTIALS"): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(purpose), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptSecret(payload: string, purpose: EncryptionPurpose = "NODE_CREDENTIALS"): string {
  const [ivRaw, tagRaw, encryptedRaw] = payload.split(":");
  if (!ivRaw || !tagRaw || !encryptedRaw) {
    throw new Error("Invalid encrypted payload format");
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getKey(purpose),
    Buffer.from(ivRaw, "base64")
  );
  decipher.setAuthTag(Buffer.from(tagRaw, "base64"));
  const output = Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64")),
    decipher.final()
  ]);

  return output.toString("utf8");
}
