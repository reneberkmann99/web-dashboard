import { describe, expect, it, vi } from "vitest";
import { CaddyIngressProvider } from "@/server/services/ingress-providers/caddy";

describe("Caddy managed ingress provider", () => {
  it("publishes and removes an id-scoped HTTPS reverse proxy route", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const provider = new CaddyIngressProvider({ adminUrl: "http://gateway.internal:2019", fetchImpl });
    await provider.upsert({ id: "endpoint-1", exposure: "HTTPS", hostname: "app.example.ee", backendUrl: "http://frontend.node-a.internal:8080" });
    expect(fetchImpl).toHaveBeenNthCalledWith(1, "http://gateway.internal:2019/id/noderaft-endpoint-1", expect.objectContaining({ method: "DELETE" }));
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toMatchObject({
      "@id": "noderaft-endpoint-1",
      match: [{ host: ["app.example.ee"] }],
      handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "frontend.node-a.internal:8080" }] }]
    });
  });

  it("fails closed for TCP and UDP without the layer4 plugin", async () => {
    const provider = new CaddyIngressProvider({ adminUrl: "http://gateway.internal:2019", fetchImpl: vi.fn().mockResolvedValue(new Response(null, { status: 404 })) });
    await expect(provider.upsert({ id: "tcp", exposure: "TCP", hostname: null, backendUrl: "http://db.node:5432" })).rejects.toThrow("PROVIDER_PROTOCOL_UNSUPPORTED");
  });

  it("reports an unavailable disposable backend", async () => {
    const provider = new CaddyIngressProvider({ adminUrl: "http://gateway.internal:2019", fetchImpl: vi.fn().mockRejectedValue(new Error("connection refused")) });
    await expect(provider.probe({ id: "fixture", exposure: "HTTP", hostname: "fixture.test", backendUrl: "http://fixture:8080" })).resolves.toEqual({ ok: false, detail: "connection refused" });
  });
});
