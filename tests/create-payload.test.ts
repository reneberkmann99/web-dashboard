import { describe, expect, it } from "vitest";
import { emptyService, type ComposeForm } from "@/lib/compose-form/model";
import { buildCreatePayload, extractSecretReferences } from "@/lib/compose-form/create-payload";
import { parseComposeToForm } from "@/lib/compose-form/parse";
import { serializeForm } from "@/lib/compose-form/serialize";

function formWithEnv(entries: Array<[string, string]>): ComposeForm {
  const svc = emptyService("app");
  svc.image = "nginx:stable";
  svc.environment = entries.map(([key, value], i) => ({ id: `env-${i}`, key, value, isSecret: /^\$\{/.test(value) }));
  return { services: [svc], networks: [], volumes: [], unsupportedTopLevel: {}, parseError: null };
}

describe("create-payload", () => {
  it("extracts ${KEY} environment entries as secret references only", () => {
    const form = formWithEnv([
      ["PLAIN", "hello"],
      ["DB_PASSWORD", "${DB_PASSWORD}"],
      ["NESTED", "prefix-${DB_PASSWORD}"]
    ]);
    expect(extractSecretReferences(form)).toEqual(["DB_PASSWORD"]);
  });

  it("deduplicates secret references across services", () => {
    const form = formWithEnv([["TOKEN", "${TOKEN}"], ["TOKEN", "${TOKEN}"]]);
    // second entry has same key — dedupe set keeps one
    expect(extractSecretReferences(form)).toEqual(["TOKEN"]);
  });

  it("builds a create payload whose compose round-trips to the same form", () => {
    const form = formWithEnv([
      ["PORT", "8080"],
      ["API_KEY", "${API_KEY}"]
    ]);
    const payload = buildCreatePayload(form);
    expect(payload.environment).toEqual({});
    expect(payload.secretReferences).toEqual(["API_KEY"]);
    expect(payload.compose).toContain("nginx:stable");
    expect(payload.compose).toContain("API_KEY");
    expect(payload.compose).toContain("${API_KEY}");

    const reparsed = parseComposeToForm(payload.compose, payload.secretReferences);
    expect(reparsed.parseError).toBeNull();
    expect(reparsed.services[0].image).toBe("nginx:stable");
    expect(reparsed.services[0].environment).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "API_KEY", value: "${API_KEY}", isSecret: true })
      ])
    );
  });

  it("serializes a full multi-service form and keeps ports/networks/volumes", () => {
    const a = emptyService("web");
    a.image = "nginx:stable";
    a.ports = [{ id: "p1", hostIp: "", published: "8080", target: "80", protocol: "tcp" }];
    a.networks = [{ id: "n1", name: "front", aliases: [] }];
    a.volumes = [{ id: "v1", kind: "volume", source: "data", target: "/data", readOnly: false, longForm: false }];
    const b = emptyService("worker");
    b.image = "busybox:latest";
    b.command = "sleep 3600";
    b.restart = "no";
    const form: ComposeForm = {
      services: [a, b],
      networks: [{ id: "tn1", name: "front", external: false, driver: "", extra: {} }],
      volumes: [{ id: "tv1", name: "data", external: false, driver: "", extra: {} }],
      unsupportedTopLevel: {},
      parseError: null
    };
    const yaml = serializeForm(form);
    const reparsed = parseComposeToForm(yaml, []);
    expect(reparsed.parseError).toBeNull();
    expect(reparsed.services.map((s) => s.name)).toEqual(["web", "worker"]);
    expect(reparsed.services[0].ports).toHaveLength(1);
    expect(reparsed.services[0].networks[0].name).toBe("front");
    expect(reparsed.services[0].volumes[0].source).toBe("data");
    expect(reparsed.networks[0].name).toBe("front");
    expect(reparsed.volumes[0].name).toBe("data");
  });
});
