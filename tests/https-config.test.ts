import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { NextResponse } from "next/server";
import { setSessionCookie } from "@/server/auth/session";

const root = path.resolve(__dirname, "..");

describe("VPN HTTPS deployment", () => {
  it("publishes only nginx TLS on 1337 and keeps Next.js private", () => {
    const compose = parse(fs.readFileSync(path.join(root, "docker-compose.yml"), "utf8")) as {
      services: Record<string, { ports?: string[]; expose?: string[]; volumes?: string[]; healthcheck?: unknown; environment?: Record<string, string> }>;
    };
    expect(compose.services.web.ports).toBeUndefined();
    expect(compose.services.web.expose).toContain("3000");
    expect(compose.services.web.healthcheck).toBeTruthy();
    expect(compose.services.proxy.ports).toContain("1337:8443");
    expect(compose.services.proxy.volumes?.some((mount) => mount.includes("/etc/nginx/tls:ro"))).toBe(true);
    expect(compose.services.proxy.healthcheck).toBeTruthy();
    expect(compose.services.web.environment?.SMTP_CREDENTIALS_KEY).toBe("${SMTP_CREDENTIALS_KEY:-}");
  });

  it("uses modern TLS/security headers and explicitly disables SSE buffering", () => {
    const config = fs.readFileSync(path.join(root, "deploy/nginx/hostpanel.conf"), "utf8");
    expect(config).toContain("ssl_protocols TLSv1.2 TLSv1.3");
    expect(config).not.toMatch(/TLSv1(?:\.0|\.1)?\s/);
    expect(config).toContain("X-Content-Type-Options");
    expect(config).toContain("frame-ancestors 'none'");
    expect(config).not.toContain("Strict-Transport-Security");
    expect(config).toMatch(/logs\/stream\$[\s\S]*proxy_buffering off/);
    expect(config).toMatch(/logs\/stream\$[\s\S]*X-Accel-Buffering "no"/);
    expect(config).toMatch(/logs\/stream\$[\s\S]*proxy_read_timeout 1h/);
  });

  it("generates persistent SAN-correct material, protects the key, and refuses accidental replacement", () => {
    const tlsDir = fs.mkdtempSync(path.join(os.tmpdir(), "hostpanel-tls-test-"));
    try {
      execFileSync(path.join(root, "scripts/generate-web-tls.sh"), [], {
        cwd: root,
        env: {
          ...process.env,
          HOSTPANEL_TLS_DIR: tlsDir,
          HOSTPANEL_TLS_IP_SANS: "10.99.2.1,100.126.152.141",
          HOSTPANEL_TLS_DNS_SANS: "vmi2804346",
          HOSTPANEL_TLS_VALID_DAYS: "30"
        },
        stdio: "pipe"
      });
      const cert = path.join(tlsDir, "hostpanel.crt");
      const key = path.join(tlsDir, "hostpanel.key");
      expect(fs.existsSync(cert)).toBe(true);
      expect(fs.existsSync(key)).toBe(true);
      expect(fs.statSync(key).mode & 0o777).toBe(0o600);
      const inspection = execFileSync("openssl", ["x509", "-in", cert, "-noout", "-ext", "subjectAltName", "-fingerprint", "-sha256"], { encoding: "utf8" });
      expect(inspection).toContain("IP Address:10.99.2.1");
      expect(inspection).toContain("IP Address:100.126.152.141");
      expect(inspection).toContain("DNS:vmi2804346");
      const fingerprintBefore = inspection.match(/Fingerprint=([^\n]+)/)?.[1];
      expect(() => execFileSync(path.join(root, "scripts/generate-web-tls.sh"), [], {
        env: { ...process.env, HOSTPANEL_TLS_DIR: tlsDir },
        stdio: "pipe"
      })).toThrow();
      const after = execFileSync("openssl", ["x509", "-in", cert, "-noout", "-fingerprint", "-sha256"], { encoding: "utf8" });
      expect(after).toContain(fingerprintBefore);
    } finally {
      fs.rmSync(tlsDir, { recursive: true, force: true });
    }
  });

  it("marks production session cookies Secure while retaining HttpOnly and SameSite", () => {
    const previous = process.env.COOKIE_SECURE;
    process.env.COOKIE_SECURE = "true";
    try {
      const response = NextResponse.json({ ok: true });
      setSessionCookie(response, "fixture-token", new Date(Date.now() + 60_000));
      const cookie = response.headers.get("set-cookie") ?? "";
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=lax");
    } finally {
      if (previous === undefined) delete process.env.COOKIE_SECURE;
      else process.env.COOKIE_SECURE = previous;
    }
  });

  it("contains no insecure absolute browser endpoint and never exposes TLS material under public", () => {
    const roots = ["app/(dashboard)", "components", "lib"];
    const files: string[] = [];
    const walk = (relative: string): void => {
      for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
        const child = path.join(relative, entry.name);
        if (entry.isDirectory()) walk(child);
        else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(child);
      }
    };
    roots.forEach(walk);
    const insecure = files.filter((file) => /["'`]http:\/\//.test(fs.readFileSync(path.join(root, file), "utf8")));
    expect(insecure).toEqual([]);
    expect(fs.existsSync(path.join(root, "public/hostpanel.key"))).toBe(false);
    expect(fs.existsSync(path.join(root, "public/hostpanel.crt"))).toBe(false);
  });
});
