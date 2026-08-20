import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";

export type WebhookAddressPolicy = {
  allowPrivateNetworks: boolean;
};

export function webhookAddressPolicyFromEnv(): WebhookAddressPolicy {
  return { allowPrivateNetworks: process.env.WEBHOOK_ALLOW_PRIVATE_NETWORKS === "true" };
}

function ipv4Number(address: string): number {
  return address.split(".").reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0);
}

function inV4Range(address: string, network: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4Number(address) & mask) === (ipv4Number(network) & mask);
}

/**
 * Webhook SSRF policy:
 * - link-local/cloud-metadata addresses are always denied;
 * - loopback, RFC1918, CGNAT and ULA are denied by default;
 * - private destinations can be explicitly enabled for legitimate internal
 *   n8n/OpenClaw/webhook receivers with WEBHOOK_ALLOW_PRIVATE_NETWORKS=true;
 * - public addresses are allowed.
 */
export function classifyWebhookAddress(address: string): "public" | "private" | "blocked" {
  const family = net.isIP(address);
  if (family === 4) {
    if (inV4Range(address, "169.254.0.0", 16) || inV4Range(address, "0.0.0.0", 8)) return "blocked";
    if (
      inV4Range(address, "10.0.0.0", 8) ||
      inV4Range(address, "127.0.0.0", 8) ||
      inV4Range(address, "172.16.0.0", 12) ||
      inV4Range(address, "192.168.0.0", 16) ||
      inV4Range(address, "100.64.0.0", 10)
    ) return "private";
    if (inV4Range(address, "224.0.0.0", 4)) return "blocked";
    return "public";
  }
  if (family === 6) {
    const normalized = address.toLowerCase().split("%")[0];
    if (normalized === "::" || normalized === "::1") return "private";
    if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return "blocked";
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return "private";
    if (normalized.startsWith("ff")) return "blocked";
    // IPv4-mapped addresses must be evaluated under the IPv4 policy.
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    return mapped ? classifyWebhookAddress(mapped) : "public";
  }
  return "blocked";
}

export function parseWebhookUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("WEBHOOK_URL_INVALID");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("WEBHOOK_URL_PROTOCOL");
  if (url.username || url.password) throw new Error("WEBHOOK_URL_CREDENTIALS_FORBIDDEN");
  if (url.hash) throw new Error("WEBHOOK_URL_FRAGMENT_FORBIDDEN");
  if (!url.hostname) throw new Error("WEBHOOK_URL_INVALID");
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    hostname === "metadata.google.internal" ||
    hostname.endsWith(".metadata.google.internal") ||
    hostname === "instance-data.ec2.internal"
  ) throw new Error("WEBHOOK_TARGET_BLOCKED");
  return url;
}

export async function resolveWebhookTarget(
  rawUrl: string,
  policy = webhookAddressPolicyFromEnv()
): Promise<{ url: URL; address: string; family: 4 | 6 }> {
  const url = parseWebhookUrl(rawUrl);
  const literalFamily = net.isIP(url.hostname.replace(/^\[|\]$/g, ""));
  const addresses = literalFamily
    ? [{ address: url.hostname.replace(/^\[|\]$/g, ""), family: literalFamily }]
    : await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error("WEBHOOK_DNS_EMPTY");

  // Validate every answer, not merely the one selected. A hostname that
  // resolves to both public and blocked/private space is rejected, avoiding
  // trivial round-robin/DNS-rebinding bypasses.
  for (const answer of addresses) {
    const classification = classifyWebhookAddress(answer.address);
    if (classification === "blocked" || (classification === "private" && !policy.allowPrivateNetworks)) {
      throw new Error("WEBHOOK_TARGET_BLOCKED");
    }
  }
  const selected = addresses[0];
  return { url, address: selected.address, family: selected.family as 4 | 6 };
}

export type WebhookResponse = { statusCode: number };

/**
 * POST using a DNS-pinned socket target and the original Host/SNI identity.
 * Native http(s).request does not follow redirects, so a 3xx cannot escape
 * the address validation performed above.
 */
export async function postWebhook(input: {
  url: string;
  body: string;
  headers: Record<string, string>;
  timeoutMs?: number;
  policy?: WebhookAddressPolicy;
}): Promise<WebhookResponse> {
  const resolved = await resolveWebhookTarget(input.url, input.policy);
  const timeoutMs = input.timeoutMs ?? Number(process.env.WEBHOOK_TIMEOUT_MS ?? 8_000);
  const port = resolved.url.port
    ? Number(resolved.url.port)
    : resolved.url.protocol === "https:" ? 443 : 80;
  const defaultPort = resolved.url.protocol === "https:" ? 443 : 80;
  const hostHeader = port === defaultPort ? resolved.url.hostname : `${resolved.url.hostname}:${port}`;
  const transport = resolved.url.protocol === "https:" ? https : http;

  return new Promise<WebhookResponse>((resolve, reject) => {
    const request = transport.request({
      protocol: resolved.url.protocol,
      hostname: resolved.address,
      family: resolved.family,
      port,
      method: "POST",
      path: `${resolved.url.pathname}${resolved.url.search}`,
      servername: net.isIP(resolved.url.hostname) ? undefined : resolved.url.hostname,
      headers: {
        Host: hostHeader,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(input.body).toString(),
        ...input.headers
      },
      timeout: timeoutMs
    }, (response) => {
      response.on("error", () => undefined);
      response.resume();
      resolve({ statusCode: response.statusCode ?? 0 });
    });
    request.on("timeout", () => request.destroy(new Error("WEBHOOK_TIMEOUT")));
    request.on("error", (error) => {
      const safe = error.message === "WEBHOOK_TIMEOUT" ? "WEBHOOK_TIMEOUT" : "WEBHOOK_CONNECTION_FAILED";
      reject(new Error(safe));
    });
    request.end(input.body);
  });
}
