import { describe, expect, it } from "vitest";
import {
  signRequest,
  verifyRequestSignature,
  withinTimestampWindow,
  NonceCache,
  sha256Hex,
  buildSignatureString
} from "@/server/security/agent-signing";
import { managedDeploymentExecutionSupported } from "@/server/services/node-agent/transport";

describe("agent request signing + replay protection", () => {
  const keyA = "a".repeat(64);
  const keyB = "b".repeat(64);
  const now = Math.floor(Date.now() / 1000);
  const fields = {
    method: "POST",
    path: "/deployments/c1/apply",
    timestamp: now,
    nonce: "nonce-1",
    bodySha256: sha256Hex('{"secrets":{"DB":"x"}}'),
    operationId: "op-1"
  };

  it("valid signature verifies", () => {
    const sig = signRequest(keyA, fields);
    expect(verifyRequestSignature(keyA, fields, sig)).toBe(true);
  });

  it("wrong key fails (node A cannot sign for node B)", () => {
    const sig = signRequest(keyA, fields);
    expect(verifyRequestSignature(keyB, fields, sig)).toBe(false);
  });

  it("tampered body (different bodySha256) fails", () => {
    const sig = signRequest(keyA, fields);
    expect(verifyRequestSignature(keyA, { ...fields, bodySha256: sha256Hex("tampered") }, sig)).toBe(false);
  });

  it("expired timestamp is rejected by the window check", () => {
    expect(withinTimestampWindow(now)).toBe(true);
    expect(withinTimestampWindow(now - 301)).toBe(false);
    expect(withinTimestampWindow(now + 301)).toBe(false);
  });

  it("nonce cache rejects replays and accepts fresh nonces", () => {
    const cache = new NonceCache();
    expect(cache.checkAndRecord("n1", now)).toBe(true);
    expect(cache.checkAndRecord("n1", now)).toBe(false); // replay
    expect(cache.checkAndRecord("n2", now)).toBe(true);
  });

  it("signature string is canonical and deterministic", () => {
    expect(buildSignatureString(fields)).toBe(
      `POST\n/deployments/c1/apply\n${now}\nnonce-1\n${fields.bodySha256}\nop-1`
    );
  });
});

describe("managed deployment execution capability gate", () => {
  it("requires TLS_VERIFIED + composeSupported + active", () => {
    expect(managedDeploymentExecutionSupported({ isActive: true, transportMode: "TLS_VERIFIED", composeSupported: true }).supported).toBe(true);
    expect(managedDeploymentExecutionSupported({ isActive: true, transportMode: "LEGACY_HTTP", composeSupported: true }).supported).toBe(false);
    expect(managedDeploymentExecutionSupported({ isActive: true, transportMode: "TLS_VERIFIED", composeSupported: false }).supported).toBe(false);
    expect(managedDeploymentExecutionSupported({ isActive: false, transportMode: "TLS_VERIFIED", composeSupported: true }).supported).toBe(false);
  });

  it("LEGACY_HTTP reason explains secure transport is missing", () => {
    const r = managedDeploymentExecutionSupported({ isActive: true, transportMode: "LEGACY_HTTP", composeSupported: true });
    expect(r.reason).toMatch(/secure agent transport/);
  });
});
