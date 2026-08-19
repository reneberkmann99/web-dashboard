#!/usr/bin/env tsx
/**
 * HostPanel Agent CA bootstrap (deliberate admin action — NEVER automatic).
 *
 * Creates the internal CA used to issue node agent server certificates.
 * Refuses to overwrite an existing CA.
 *
 *   npx tsx scripts/bootstrap-agent-ca.ts
 *
 * Environment:
 *   HOSTPANEL_AGENT_CA_CERT_PATH  (default /data/pki/hostpanel-agent-ca.pem)
 *   HOSTPANEL_AGENT_CA_KEY_PATH   (default /data/pki/hostpanel-agent-ca-key.pem)
 *
 * Runs on the host or inside the web container (npx tsx will fetch tsx on
 * first use in the container). Self-contained: uses node-forge directly so it
 * needs no imports from the application source tree.
 *
 * BACKUP REQUIREMENT
 * ------------------
 * The CA private key is a high-value secret AND a single point of identity for
 * the whole fleet:
 *   - Back it up encrypted, off-box, with restrictive permissions (0600).
 *   - Losing it means you cannot issue or rotate ANY node certificate; every
 *     node must be re-enrolled after bootstrapping a replacement CA.
 *   - Leaking it lets an attacker impersonate any HostPanel agent — treat it
 *     like a root credential.
 *   - It must never be committed, baked into an image, or stored in Postgres.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import forge from "node-forge";

function caCertPath(): string {
  return process.env.HOSTPANEL_AGENT_CA_CERT_PATH ?? "/data/pki/hostpanel-agent-ca.pem";
}

function caKeyPath(): string {
  return process.env.HOSTPANEL_AGENT_CA_KEY_PATH ?? "/data/pki/hostpanel-agent-ca-key.pem";
}

function caExists(): boolean {
  try {
    return fs.existsSync(caCertPath()) && fs.existsSync(caKeyPath());
  } catch {
    return false;
  }
}

function fingerprintFromPem(certPem: string): string {
  const cert = forge.pki.certificateFromPem(certPem);
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  return crypto.createHash("sha256").update(Buffer.from(der, "binary")).digest("hex");
}

function main(): void {
  if (caExists()) {
    console.error(`Agent CA already exists:\n  cert: ${caCertPath()}\n  key:  ${caKeyPath()}`);
    console.error("Refusing to overwrite. Back up and remove the existing CA first if you intend to replace it.");
    process.exit(1);
  }

  console.log("Generating HostPanel Agent CA (RSA-4096, 10 years)…");
  const keys = forge.pki.rsa.generateKeyPair(4096);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01" + crypto.randomBytes(8).toString("hex");
  cert.validity.notBefore = new Date(Date.now() - 5 * 60 * 1000);
  cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000);
  cert.setSubject([
    { name: "commonName", value: "HostPanel Agent CA" },
    { name: "organizationName", value: "HostPanel" }
  ]);
  cert.setIssuer(cert.subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
    { name: "subjectKeyIdentifier" }
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const certPem = forge.pki.certificateToPem(cert);
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

  for (const p of [caCertPath(), caKeyPath()]) {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(caCertPath(), certPem, { mode: 0o644 });
  fs.writeFileSync(caKeyPath(), keyPem, { mode: 0o600 });

  console.log("\nAgent CA created:");
  console.log(`  certificate : ${caCertPath()} (0644, safe to distribute)`);
  console.log(`  private key : ${caKeyPath()} (0600, BACK THIS UP SECURELY)`);
  console.log(`  fingerprint : ${fingerprintFromPem(certPem)}`);
  console.log("\nNext: enroll a node via Node → Configuration → Secure agent transport.");
}

main();
