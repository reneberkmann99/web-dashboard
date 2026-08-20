import fs from "node:fs";
import crypto from "node:crypto";
import forge from "node-forge";

/**
 * Noderaft Agent PKI (Phase 6B.1).
 *
 * A small internal CA that issues SERVER certificates for Noderaft node
 * agents. The agent generates its own private key locally and sends only a
 * CSR; the control plane signs a certificate whose identity is chosen by
 * Noderaft (never taken from the CSR).
 *
 * Trust model: server-authenticated TLS (agent proves it is the expected node)
 * PLUS the existing per-node HMAC (proves the request came from the control
 * plane, unmodified and unreplayed). Not mTLS — see ADR-0011.
 *
 * The CA private key lives ONLY on the control-plane filesystem
 * (HOSTPANEL_AGENT_CA_KEY_PATH, mode 0600). It is never in Postgres, never in
 * an API response, never logged, and never baked into an image.
 */

export const AGENT_CERT_LIFETIME_DAYS = 90;
export const CERT_EXPIRY_WARNING_DAYS = 14;
export const CERT_EXPIRY_CRITICAL_DAYS = 0;

const MAX_PEM_BYTES = 16 * 1024;

export function caCertPath(): string {
  return process.env.HOSTPANEL_AGENT_CA_CERT_PATH ?? "/data/pki/hostpanel-agent-ca.pem";
}

export function caKeyPath(): string {
  return process.env.HOSTPANEL_AGENT_CA_KEY_PATH ?? "/data/pki/hostpanel-agent-ca-key.pem";
}

export function caExists(): boolean {
  try {
    return fs.existsSync(caCertPath()) && fs.existsSync(caKeyPath());
  } catch {
    return false;
  }
}

/** Public CA certificate PEM (safe to distribute). */
export function readCaCertPem(): string {
  const pem = fs.readFileSync(caCertPath(), "utf8");
  if (pem.length > MAX_PEM_BYTES) throw new Error("CA certificate is unexpectedly large");
  return pem;
}

function readCaKeyPem(): string {
  const pem = fs.readFileSync(caKeyPath(), "utf8");
  if (pem.length > MAX_PEM_BYTES * 4) throw new Error("CA key is unexpectedly large");
  return pem;
}

/**
 * Logical, Noderaft-controlled node identity. Deliberately NOT the node's IP
 * or management hostname, so changing a node's address never invalidates its
 * certificate. Used as the TLS servername (SNI) + verified SAN.
 */
export function nodeIdentity(nodeId: string): string {
  return `node-${nodeId}.agents.hostpanel.internal`;
}

export type IssuedCertificate = {
  certPem: string;
  caPem: string;
  serialNumber: string;
  fingerprintSha256: string;
  notBefore: Date;
  notAfter: Date;
  identity: string;
};

/** SHA-256 fingerprint of a certificate's DER encoding, lowercase hex. */
export function fingerprintFromPem(certPem: string): string {
  const cert = forge.pki.certificateFromPem(certPem);
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  return crypto.createHash("sha256").update(Buffer.from(der, "binary")).digest("hex");
}

export function serialFromPem(certPem: string): string {
  return forge.pki.certificateFromPem(certPem).serialNumber.replace(/^0+/, "").toLowerCase();
}

/**
 * Bootstrap a new Agent CA. Deliberately NOT called on application startup —
 * only by the explicit admin bootstrap script (scripts/bootstrap-agent-ca.ts).
 * Refuses to overwrite an existing CA.
 */
export function bootstrapCa(options?: { years?: number }): { certPath: string; keyPath: string; fingerprint: string } {
  if (caExists()) {
    throw new Error("Agent CA already exists — refusing to overwrite. Remove/back up the existing CA first.");
  }
  const years = options?.years ?? 10;
  const keys = forge.pki.rsa.generateKeyPair(4096);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01" + crypto.randomBytes(8).toString("hex");
  cert.validity.notBefore = new Date(Date.now() - 5 * 60 * 1000);
  cert.validity.notAfter = new Date(Date.now() + years * 365 * 24 * 60 * 60 * 1000);
  const attrs = [
    { name: "commonName", value: "Noderaft Agent CA" },
    { name: "organizationName", value: "Noderaft" }
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
    { name: "subjectKeyIdentifier" }
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const certPem = forge.pki.certificateToPem(cert);
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

  for (const p of [caCertPath(), caKeyPath()]) {
    fs.mkdirSync(require("node:path").dirname(p), { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(caCertPath(), certPem, { mode: 0o644 });
  fs.writeFileSync(caKeyPath(), keyPem, { mode: 0o600 });

  return { certPath: caCertPath(), keyPath: caKeyPath(), fingerprint: fingerprintFromPem(certPem) };
}

/**
 * Sign a node agent CSR. The CSR supplies ONLY the public key; the subject and
 * every SAN are chosen by Noderaft from the Node record. Any SAN/subject the
 * CSR requested is ignored.
 */
export function signNodeCsr(input: {
  nodeId: string;
  csrPem: string;
  lifetimeDays?: number;
}): IssuedCertificate {
  if (!caExists()) {
    throw new Error("AGENT_CA_NOT_CONFIGURED");
  }
  if (input.csrPem.length > MAX_PEM_BYTES) {
    throw new Error("CSR too large");
  }

  let csr: forge.pki.CertificateSigningRequest;
  try {
    csr = forge.pki.certificationRequestFromPem(input.csrPem);
  } catch {
    throw new Error("INVALID_CSR");
  }
  if (!csr.verify()) {
    throw new Error("INVALID_CSR_SIGNATURE");
  }
  if (!csr.publicKey) {
    throw new Error("INVALID_CSR_NO_PUBLIC_KEY");
  }

  const caCert = forge.pki.certificateFromPem(readCaCertPem());
  const caKey = forge.pki.privateKeyFromPem(readCaKeyPem());

  const identity = nodeIdentity(input.nodeId);
  const lifetimeDays = input.lifetimeDays ?? AGENT_CERT_LIFETIME_DAYS;

  const cert = forge.pki.createCertificate();
  cert.publicKey = csr.publicKey;
  cert.serialNumber = "01" + crypto.randomBytes(12).toString("hex");
  cert.validity.notBefore = new Date(Date.now() - 5 * 60 * 1000);
  cert.validity.notAfter = new Date(Date.now() + lifetimeDays * 24 * 60 * 60 * 1000);

  // Subject/SAN are Noderaft-controlled — CSR-requested values are discarded.
  cert.setSubject([
    { name: "commonName", value: identity },
    { name: "organizationName", value: "Noderaft Agent" }
  ]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: false, critical: true },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames: [{ type: 2, value: identity }] }, // type 2 = dNSName
    { name: "subjectKeyIdentifier" }
  ]);
  cert.sign(caKey, forge.md.sha256.create());

  const certPem = forge.pki.certificateToPem(cert);
  return {
    certPem,
    caPem: readCaCertPem(),
    serialNumber: cert.serialNumber.replace(/^0+/, "").toLowerCase(),
    fingerprintSha256: fingerprintFromPem(certPem),
    notBefore: cert.validity.notBefore,
    notAfter: cert.validity.notAfter,
    identity
  };
}

/** Days remaining until a certificate expires (may be negative). */
export function daysUntil(notAfter: Date, now = new Date()): number {
  return Math.floor((notAfter.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
}
