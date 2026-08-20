import { describe, expect, it } from "vitest";
import { classifyWebhookAddress, parseWebhookUrl, resolveWebhookTarget } from "@/server/security/webhook-security";

describe("webhook SSRF controls", () => {
  it("blocks cloud metadata/link-local targets even when private webhooks are enabled", async () => {
    expect(classifyWebhookAddress("169.254.169.254")).toBe("blocked");
    await expect(resolveWebhookTarget("http://169.254.169.254/latest/meta-data", { allowPrivateNetworks: true }))
      .rejects.toThrow("WEBHOOK_TARGET_BLOCKED");
    expect(() => parseWebhookUrl("http://metadata.google.internal/computeMetadata/v1"))
      .toThrow("WEBHOOK_TARGET_BLOCKED");
  });

  it("denies loopback/RFC1918 by default and permits them only under explicit policy", async () => {
    expect(classifyWebhookAddress("127.0.0.1")).toBe("private");
    expect(classifyWebhookAddress("10.1.2.3")).toBe("private");
    await expect(resolveWebhookTarget("http://127.0.0.1:8080/hook", { allowPrivateNetworks: false }))
      .rejects.toThrow("WEBHOOK_TARGET_BLOCKED");
    await expect(resolveWebhookTarget("http://127.0.0.1:8080/hook", { allowPrivateNetworks: true }))
      .resolves.toMatchObject({ address: "127.0.0.1" });
  });

  it("rejects embedded credentials, non-http protocols, and fragments", () => {
    expect(() => parseWebhookUrl("https://user:pass@example.com/hook")).toThrow("WEBHOOK_URL_CREDENTIALS_FORBIDDEN");
    expect(() => parseWebhookUrl("file:///etc/passwd")).toThrow("WEBHOOK_URL_PROTOCOL");
    expect(() => parseWebhookUrl("https://example.com/hook#secret")).toThrow("WEBHOOK_URL_FRAGMENT_FORBIDDEN");
  });
});
