import { describe, it, expect } from "vitest";
import {
  encryptSecret,
  decryptSecret,
  isEncryptionKeyConfigured
} from "@/server/security/crypto";

describe("deployment crypto (typed key purposes)", () => {
  it("round-trips with DEPLOYMENT_SECRETS purpose", () => {
    const ct = encryptSecret("s3cr3t-value", "DEPLOYMENT_SECRETS");
    expect(ct).not.toContain("s3cr3t-value");
    expect(decryptSecret(ct, "DEPLOYMENT_SECRETS")).toBe("s3cr3t-value");
  });

  it("existing node credential crypto still works (default purpose)", () => {
    const ct = encryptSecret("agent-key");
    expect(decryptSecret(ct)).toBe("agent-key");
  });

  it("produces unique ciphertext for identical plaintext (unique IV)", () => {
    const a = encryptSecret("same-value", "DEPLOYMENT_SECRETS");
    const b = encryptSecret("same-value", "DEPLOYMENT_SECRETS");
    expect(a).not.toBe(b);
    expect(decryptSecret(a, "DEPLOYMENT_SECRETS")).toBe("same-value");
    expect(decryptSecret(b, "DEPLOYMENT_SECRETS")).toBe("same-value");
  });

  it("fails closed when decrypting with a different key", () => {
    const ct = encryptSecret("value", "DEPLOYMENT_SECRETS");
    const saved = process.env.DEPLOYMENT_SECRETS_KEY;
    process.env.DEPLOYMENT_SECRETS_KEY = "c".repeat(64);
    try {
      expect(() => decryptSecret(ct, "DEPLOYMENT_SECRETS")).toThrow();
    } finally {
      process.env.DEPLOYMENT_SECRETS_KEY = saved;
    }
  });

  it("fails on malformed ciphertext", () => {
    expect(() => decryptSecret("not-a-valid-payload", "DEPLOYMENT_SECRETS")).toThrow();
  });

  it("missing deployment key fails safely and clearly, only when used", () => {
    const saved = process.env.DEPLOYMENT_SECRETS_KEY;
    delete process.env.DEPLOYMENT_SECRETS_KEY;
    try {
      expect(isEncryptionKeyConfigured("DEPLOYMENT_SECRETS")).toBe(false);
      expect(() => encryptSecret("x", "DEPLOYMENT_SECRETS")).toThrow(/DEPLOYMENT_SECRETS_KEY/);
      // Node-credential crypto must be unaffected by the missing deployment key.
      const ct = encryptSecret("node-key");
      expect(decryptSecret(ct)).toBe("node-key");
    } finally {
      process.env.DEPLOYMENT_SECRETS_KEY = saved;
    }
  });
});
