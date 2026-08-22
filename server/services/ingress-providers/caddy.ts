import type { ManagedIngressProvider, ManagedRoute } from "./types";

type CaddyOptions = { adminUrl: string; bearerToken?: string; fetchImpl?: typeof fetch };

/** Caddy's native Admin API is used; Noderaft never reads or writes Caddy storage. */
export class CaddyIngressProvider implements ManagedIngressProvider {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: CaddyOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    if (!/^https?:\/\//.test(options.adminUrl)) throw new Error("INVALID_CADDY_ADMIN_URL");
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const response = await this.fetchImpl(`${this.options.adminUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(this.options.bearerToken ? { authorization: `Bearer ${this.options.bearerToken}` } : {}) }
    });
    if (!response.ok) throw new Error(`CADDY_ADMIN_${response.status}`);
    return response;
  }

  async upsert(route: ManagedRoute): Promise<void> {
    if (route.exposure === "TCP" || route.exposure === "UDP") throw new Error("PROVIDER_PROTOCOL_UNSUPPORTED");
    const body = JSON.stringify({
      "@id": `noderaft-${route.id}`,
      match: [{ host: [route.hostname] }],
      handle: [{ handler: "reverse_proxy", upstreams: [{ dial: new URL(route.backendUrl).host }] }],
      terminal: true
    });
    // PUT replaces an existing @id atomically. Only a missing route needs an append.
    const existing = await this.fetchImpl(`${this.options.adminUrl.replace(/\/$/, "")}/id/noderaft-${route.id}`, { headers: this.options.bearerToken ? { authorization: `Bearer ${this.options.bearerToken}` } : undefined });
    await this.request(existing.ok ? `/id/noderaft-${route.id}` : "/config/apps/http/servers/noderaft/routes", { method: existing.ok ? "PUT" : "POST", body });
  }

  async remove(routeId: string): Promise<void> {
    const response = await this.fetchImpl(`${this.options.adminUrl.replace(/\/$/, "")}/id/noderaft-${routeId}`, {
      method: "DELETE",
      headers: this.options.bearerToken ? { authorization: `Bearer ${this.options.bearerToken}` } : undefined
    });
    if (!response.ok && response.status !== 404) throw new Error(`CADDY_ADMIN_${response.status}`);
  }

  async probe(route: ManagedRoute): Promise<{ ok: boolean; detail?: string }> {
    try {
      const response = await this.fetchImpl(route.backendUrl, { signal: AbortSignal.timeout(5000) });
      return { ok: response.status < 500, detail: `Backend returned HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : "Backend unavailable" };
    }
  }

  async verifyTls(route: ManagedRoute): Promise<{ status: "ISSUED" | "PENDING" | "DNS_INVALID" | "FAILED"; detail?: string }> {
    if (route.exposure !== "HTTPS" || !route.hostname) return { status: "ISSUED" };
    try {
      const response = await this.fetchImpl(`https://${route.hostname}`, { redirect: "manual", signal: AbortSignal.timeout(5000) });
      return response.status > 0 ? { status: "ISSUED", detail: `HTTPS returned ${response.status}` } : { status: "PENDING" };
    } catch (error) {
      const detail = error instanceof Error ? error.message : "TLS verification failed";
      if (/ENOTFOUND|EAI_AGAIN|name.*resolve|dns/i.test(detail)) return { status: "DNS_INVALID", detail };
      if (/certificate|tls|ssl|acme/i.test(detail)) return { status: "FAILED", detail };
      return { status: "PENDING", detail };
    }
  }
}
