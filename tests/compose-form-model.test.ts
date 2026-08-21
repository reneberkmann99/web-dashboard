import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { parseComposeToForm } from "@/lib/compose-form/parse";
import { serializeForm } from "@/lib/compose-form/serialize";
import { validateComposeForm, hasBlockingIssues } from "@/lib/compose-form/validate";
import { diffComposeSources } from "@/lib/compose-form/diff";
import { emptyService } from "@/lib/compose-form/model";

/**
 * Structured compose form model: parse → edit → serialize must be lossless for
 * everything Noderaft claims to support, and must never silently drop options
 * it does not support.
 *
 * These are pure-function tests (no DB, no Docker) — they exercise the layer the
 * form editor sits on top of.
 */

const FULL = `services:
  web:
    image: nginx:1.28
    command: nginx -g 'daemon off;'
    hostname: web-host
    working_dir: /usr/share/nginx
    user: "101:101"
    restart: unless-stopped
    read_only: true
    cap_drop:
      - ALL
    cap_add:
      - NET_BIND_SERVICE
    ports:
      - "8080:80"
      - "127.0.0.1:8443:443"
      - "5353:5353/udp"
    environment:
      APP_ENV: production
      DB_PASSWORD: \${DB_PASSWORD}
    networks:
      frontend:
        aliases:
          - web-alias
      shared-net: null
    volumes:
      - web-data:/var/lib/data
      - /srv/host/config:/etc/nginx/conf.d:ro
    healthcheck:
      test:
        - CMD-SHELL
        - curl -f http://localhost/ || exit 1
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
    labels:
      owner: platform
    deploy:
      resources:
        limits:
          memory: 512m
          cpus: "0.5"
        reservations:
          memory: 128m
    depends_on:
      - db
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
    volumes:
      - db-data:/var/lib/postgresql/data
networks:
  frontend: null
  shared-net:
    external: true
volumes:
  web-data: null
  db-data: null
`;

describe("compose form model — parsing", () => {
  it("parses every structured field of a full service", () => {
    const form = parseComposeToForm(FULL, ["DB_PASSWORD", "POSTGRES_PASSWORD"]);
    expect(form.parseError).toBeNull();
    expect(form.services.map((s) => s.name)).toEqual(["web", "db"]);

    const web = form.services[0];
    expect(web.image).toBe("nginx:1.28");
    expect(web.command).toBe("nginx -g 'daemon off;'");
    expect(web.hostname).toBe("web-host");
    expect(web.workingDir).toBe("/usr/share/nginx");
    expect(web.user).toBe("101:101");
    expect(web.restart).toBe("unless-stopped");
    expect(web.readOnly).toBe(true);
    expect(web.privileged).toBe(false);
    expect(web.capDrop).toEqual(["ALL"]);
    expect(web.capAdd).toEqual(["NET_BIND_SERVICE"]);
    expect(web.dependsOn).toEqual(["db"]);
  });

  it("parses ports into host ip / published / target / protocol", () => {
    const web = parseComposeToForm(FULL).services[0];
    expect(web.ports).toHaveLength(3);
    expect(web.ports[0]).toMatchObject({ hostIp: "", published: "8080", target: "80", protocol: "tcp" });
    expect(web.ports[1]).toMatchObject({ hostIp: "127.0.0.1", published: "8443", target: "443", protocol: "tcp" });
    expect(web.ports[2]).toMatchObject({ hostIp: "", published: "5353", target: "5353", protocol: "udp" });
  });

  it("marks secret-referencing environment entries without exposing values", () => {
    const form = parseComposeToForm(FULL, ["DB_PASSWORD"]);
    const web = form.services[0];
    const dbPass = web.environment.find((e) => e.key === "DB_PASSWORD");
    expect(dbPass?.isSecret).toBe(true);
    const appEnv = web.environment.find((e) => e.key === "APP_ENV");
    expect(appEnv?.isSecret).toBe(false);
    // A ${VAR} that is NOT a declared secret is not marked secret.
    const notSecret = parseComposeToForm(FULL, []).services[0].environment.find((e) => e.key === "DB_PASSWORD");
    expect(notSecret?.isSecret).toBe(false);
  });

  it("distinguishes named volumes from bind mounts and read-only flags", () => {
    const web = parseComposeToForm(FULL).services[0];
    expect(web.volumes[0]).toMatchObject({ kind: "volume", source: "web-data", target: "/var/lib/data", readOnly: false });
    expect(web.volumes[1]).toMatchObject({ kind: "bind", source: "/srv/host/config", target: "/etc/nginx/conf.d", readOnly: true });
  });

  it("parses networks with aliases and distinguishes external top-level networks", () => {
    const form = parseComposeToForm(FULL);
    const web = form.services[0];
    expect(web.networks.map((n) => n.name)).toEqual(["frontend", "shared-net"]);
    expect(web.networks[0].aliases).toEqual(["web-alias"]);
    expect(form.networks.find((n) => n.name === "shared-net")?.external).toBe(true);
    expect(form.networks.find((n) => n.name === "frontend")?.external).toBe(false);
  });

  it("parses healthcheck and resource limits", () => {
    const web = parseComposeToForm(FULL).services[0];
    expect(web.healthcheck).toMatchObject({
      enabled: true,
      testKind: "shell",
      test: "curl -f http://localhost/ || exit 1",
      interval: "30s",
      timeout: "5s",
      retries: "3",
      startPeriod: "10s"
    });
    expect(web.resources).toMatchObject({
      memoryLimit: "512m",
      cpuLimit: "0.5",
      memoryReservation: "128m",
      style: "deploy"
    });
  });

  it("parses shorthand mem_limit/cpus resource style", () => {
    const form = parseComposeToForm("services:\n  a:\n    image: busybox\n    mem_limit: 256m\n    cpus: 1.5\n");
    expect(form.services[0].resources).toMatchObject({ memoryLimit: "256m", cpuLimit: "1.5", style: "shorthand" });
  });

  it("reports a parse error instead of throwing on invalid YAML", () => {
    const form = parseComposeToForm("services:\n  a:\n   - [unclosed\n");
    expect(form.parseError).toBeTruthy();
    expect(form.services).toHaveLength(0);
  });
});

describe("compose form model — round-trip", () => {
  it("round-trips a full compose file without semantic loss", () => {
    const form = parseComposeToForm(FULL, ["DB_PASSWORD", "POSTGRES_PASSWORD"]);
    const out = serializeForm(form);
    const before = parseYaml(FULL) as Record<string, unknown>;
    const after = parseYaml(out) as Record<string, unknown>;
    expect(after).toEqual(before);
  });

  it("is idempotent: parse(serialize(parse(x))) === parse(x)", () => {
    const once = serializeForm(parseComposeToForm(FULL));
    const twice = serializeForm(parseComposeToForm(once));
    expect(twice).toBe(once);
  });

  it("preserves unsupported runtime options verbatim instead of dropping them", () => {
    const src = `services:
  odd:
    image: busybox
    sysctls:
      net.core.somaxconn: "1024"
    devices:
      - /dev/fuse:/dev/fuse
    security_opt:
      - seccomp:unconfined
    ulimits:
      nofile:
        soft: 1024
        hard: 2048
    dns:
      - 1.1.1.1
`;
    const form = parseComposeToForm(src);
    const odd = form.services[0];
    expect(Object.keys(odd.unsupported).sort()).toEqual(["devices", "dns", "security_opt", "sysctls", "ulimits"]);
    const out = parseYaml(serializeForm(form)) as Record<string, unknown>;
    expect(out).toEqual(parseYaml(src));
  });

  it("preserves unknown top-level keys", () => {
    const src = "x-custom:\n  anchor: value\nservices:\n  a:\n    image: busybox\n";
    const form = parseComposeToForm(src);
    expect(form.unsupportedTopLevel["x-custom"]).toEqual({ anchor: "value" });
    const out = parseYaml(serializeForm(form)) as Record<string, unknown>;
    expect(out["x-custom"]).toEqual({ anchor: "value" });
  });

  it("applies a form edit and produces valid changed YAML", () => {
    const form = parseComposeToForm(FULL, ["DB_PASSWORD"]);
    form.services[0].image = "nginx:1.29";
    form.services[0].ports[0].published = "8081";
    form.services[0].environment.push({ id: "new", key: "NEW_FLAG", value: "1", isSecret: false });
    const out = parseYaml(serializeForm(form)) as {
      services: Record<string, { image: string; ports: string[]; environment: Record<string, string> }>;
    };
    expect(out.services.web.image).toBe("nginx:1.29");
    expect(out.services.web.ports[0]).toBe("8081:80");
    expect(out.services.web.environment.NEW_FLAG).toBe("1");
    // Untouched service is unchanged.
    expect(out.services.db.image).toBe("postgres:16");
  });

  it("serializes a brand-new service authored from scratch", () => {
    const svc = emptyService("api");
    svc.image = "node:22-alpine";
    svc.ports.push({ id: "p1", hostIp: "", published: "3000", target: "3000", protocol: "tcp" });
    svc.environment.push({ id: "e1", key: "NODE_ENV", value: "production", isSecret: false });
    svc.volumes.push({ id: "v1", kind: "volume", source: "api-data", target: "/data", readOnly: false, longForm: false });
    svc.healthcheck = { enabled: true, testKind: "shell", test: "wget -q --spider http://localhost:3000/", interval: "20s", timeout: "3s", retries: "3", startPeriod: "5s" };
    svc.resources = { memoryLimit: "256m", cpuLimit: "1", memoryReservation: "", cpuReservation: "", style: "deploy" };

    const yaml = serializeForm({
      services: [svc],
      networks: [],
      volumes: [{ id: "tv1", name: "api-data", external: false, driver: "", extra: {} }],
      unsupportedTopLevel: {},
      parseError: null
    });
    const parsed = parseYaml(yaml) as Record<string, Record<string, Record<string, unknown>>>;
    expect(parsed.services.api.image).toBe("node:22-alpine");
    expect(parsed.services.api.ports).toEqual(["3000:3000"]);
    expect(parsed.services.api.restart).toBe("unless-stopped");
    expect((parsed.services.api.healthcheck as Record<string, unknown>).interval).toBe("20s");
    expect(parsed.volumes["api-data"]).toBeNull();
  });
});

describe("compose form model — client-side validation", () => {
  it("accepts a valid definition", () => {
    const issues = validateComposeForm(parseComposeToForm(FULL, ["DB_PASSWORD", "POSTGRES_PASSWORD"]));
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("flags duplicate host ports across services", () => {
    const form = parseComposeToForm(
      "services:\n  a:\n    image: busybox\n    ports:\n      - \"8080:80\"\n  b:\n    image: busybox\n    ports:\n      - \"8080:81\"\n"
    );
    const issues = validateComposeForm(form);
    expect(issues.some((i) => i.severity === "error" && /already published/.test(i.message))).toBe(true);
    expect(hasBlockingIssues(issues)).toBe(true);
  });

  it("flags invalid port range, missing image, duplicate env key", () => {
    const form = parseComposeToForm("services:\n  a:\n    ports:\n      - \"70000:80\"\n");
    form.services[0].environment.push({ id: "1", key: "K", value: "a", isSecret: false });
    form.services[0].environment.push({ id: "2", key: "K", value: "b", isSecret: false });
    const issues = validateComposeForm(form);
    expect(issues.some((i) => /not a valid port/.test(i.message))).toBe(true);
    expect(issues.some((i) => /Image is required/.test(i.message))).toBe(true);
    expect(issues.some((i) => /Duplicate environment key/.test(i.message))).toBe(true);
  });

  it("flags invalid memory value and nonexistent network reference", () => {
    const form = parseComposeToForm("services:\n  a:\n    image: busybox\n    networks:\n      - ghost\n");
    form.services[0].resources.memoryLimit = "lots";
    const issues = validateComposeForm(form);
    expect(issues.some((i) => /Memory limit .* is invalid/.test(i.message))).toBe(true);
    expect(issues.some((i) => /Network "ghost" is not declared/.test(i.message))).toBe(true);
  });

  it("flags invalid volume target and warns on undeclared named volume", () => {
    const form = parseComposeToForm("services:\n  a:\n    image: busybox\n    volumes:\n      - data:relative/path\n");
    const issues = validateComposeForm(form);
    expect(issues.some((i) => /must be an absolute path/.test(i.message))).toBe(true);
    expect(issues.some((i) => i.severity === "warning" && /not declared under top-level volumes/.test(i.message))).toBe(true);
  });

  it("warns (never blocks) on unsupported runtime options", () => {
    const form = parseComposeToForm("services:\n  a:\n    image: busybox\n    devices:\n      - /dev/fuse\n");
    const issues = validateComposeForm(form);
    const unsupported = issues.find((i) => /not editable in the form/.test(i.message));
    expect(unsupported?.severity).toBe("warning");
    expect(hasBlockingIssues(issues)).toBe(false);
  });
});

describe("compose form model — structured diff", () => {
  it("renders human-readable image and port changes", () => {
    const before = "services:\n  web:\n    image: nginx:1.28\n    ports:\n      - \"8080:80\"\n";
    const after = "services:\n  web:\n    image: nginx:1.29\n    ports:\n      - \"8081:80\"\n";
    const diff = diffComposeSources(before, after);
    const web = diff.services.find((s) => s.serviceName === "web");
    expect(web?.kind).toBe("changed");
    expect(web?.changes).toContainEqual({ kind: "changed", field: "Image", before: "nginx:1.28", after: "nginx:1.29" });
    expect(web?.changes).toContainEqual({ kind: "changed", field: "Port", before: "8080:80", after: "8081:80" });
  });

  it("marks added and removed services", () => {
    const before = "services:\n  web:\n    image: nginx\n";
    const after = "services:\n  api:\n    image: node:22\n";
    const diff = diffComposeSources(before, after);
    expect(diff.services.find((s) => s.serviceName === "web")?.kind).toBe("removed");
    expect(diff.services.find((s) => s.serviceName === "api")?.kind).toBe("added");
  });

  it("NEVER exposes secret values — only key names / secret markers", () => {
    const before = "services:\n  web:\n    image: nginx\n    environment:\n      DB_PASSWORD: ${DB_PASSWORD}\n";
    const after = "services:\n  web:\n    image: nginx\n    environment:\n      DB_PASSWORD: hunter2-plaintext\n";
    const diff = diffComposeSources(before, after, ["DB_PASSWORD"]);
    const text = JSON.stringify(diff);
    expect(text).not.toContain("hunter2-plaintext");
    expect(text).toContain("secret DB_PASSWORD");
  });

  it("reports empty diff for identical definitions", () => {
    const diff = diffComposeSources(FULL, FULL, ["DB_PASSWORD"]);
    expect(diff.empty).toBe(true);
  });

  it("reports top-level network and volume additions", () => {
    const before = "services:\n  a:\n    image: busybox\n";
    const after = "services:\n  a:\n    image: busybox\nnetworks:\n  shared:\n    external: true\nvolumes:\n  data: null\n";
    const diff = diffComposeSources(before, after);
    expect(diff.networks).toContainEqual({ kind: "added", field: "Network", before: null, after: "shared (external)" });
    expect(diff.volumes).toContainEqual({ kind: "added", field: "Volume", before: null, after: "data" });
  });
});
