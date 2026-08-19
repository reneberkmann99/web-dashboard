import { describe, expect, it } from "vitest";
import {
  analyzeComposeDefinition,
  findingFingerprint,
  secretSentinel
} from "@/server/services/deployment-security";

function findings(compose: string, secretReferences: string[] = []) {
  return analyzeComposeDefinition({ composeSource: compose, secretReferences }).findings;
}

function ruleIds(compose: string, secretReferences: string[] = []) {
  return findings(compose, secretReferences).map((f) => f.ruleId);
}

describe("deployment security analyzer", () => {
  it("detects privileged as HIGH_RISK", () => {
    const f = findings("services:\n  app:\n    image: x\n    privileged: true\n");
    const p = f.find((x) => x.ruleId === "privileged");
    expect(p?.severity).toBe("HIGH_RISK");
    expect(p?.category).toBe("SECURITY");
  });

  it("detects docker socket mount as HIGH_RISK", () => {
    const f = findings('services:\n  w:\n    image: x\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n');
    expect(f.find((x) => x.ruleId === "docker-socket-mount")?.severity).toBe("HIGH_RISK");
  });

  it("detects sensitive host bind as HIGH_RISK", () => {
    const f = findings("services:\n  w:\n    image: x\n    volumes:\n      - /etc:/etc\n");
    expect(f.find((x) => x.ruleId === "sensitive-host-bind")?.severity).toBe("HIGH_RISK");
  });

  it("detects host networking as HIGH_RISK", () => {
    const f = findings("services:\n  w:\n    image: x\n    network_mode: host\n");
    expect(f.find((x) => x.ruleId === "host-networking")?.severity).toBe("HIGH_RISK");
  });

  it("detects seccomp/apparmor unconfined as HIGH_RISK", () => {
    const f = findings("services:\n  w:\n    image: x\n    security_opt:\n      - seccomp:unconfined\n");
    expect(f.find((x) => x.ruleId === "security-opt")?.severity).toBe("HIGH_RISK");
  });

  it("detects cap_add and devices", () => {
    const f = findings("services:\n  w:\n    image: x\n    cap_add:\n      - SYS_ADMIN\n    devices:\n      - /dev/sda:/dev/sda\n");
    expect(f.find((x) => x.ruleId === "cap-add")?.severity).toBe("HIGH_RISK");
    expect(f.find((x) => x.ruleId === "devices")?.severity).toBe("HIGH_RISK");
  });

  it("detects published ports as INFO", () => {
    const f = findings('services:\n  w:\n    image: x\n    ports:\n      - "8080:80"\n');
    expect(f.find((x) => x.ruleId === "published-ports")?.severity).toBe("INFO");
  });

  it("detects external networks/volumes as INFO", () => {
    const f = findings("services:\n  w:\n    image: x\nnetworks:\n  n:\n    external: true\nvolumes:\n  v:\n    external: true\n");
    expect(f.find((x) => x.ruleId === "external-networks")?.severity).toBe("INFO");
    expect(f.find((x) => x.ruleId === "external-volumes")?.severity).toBe("INFO");
  });

  it("rejects secret interpolation outside environment values (BLOCKED)", () => {
    const f = findings("services:\n  app:\n    image: ${DB_PASSWORD}\n", ["DB_PASSWORD"]);
    const r = f.find((x) => x.ruleId === "secret-interpolation-outside-environment");
    expect(r?.severity).toBe("BLOCKED");
    expect(r?.category).toBe("UNSUPPORTED");
  });

  it("allows secret interpolation inside environment values", () => {
    const f = findings("services:\n  app:\n    image: x\n    environment:\n      DB: ${DB_PASSWORD}\n", ["DB_PASSWORD"]);
    expect(f.find((x) => x.ruleId === "secret-interpolation-outside-environment")).toBeUndefined();
  });

  it("rejects env_file as BLOCKED unsupported", () => {
    const f = findings("services:\n  app:\n    image: x\n    env_file:\n      - .env\n");
    expect(f.find((x) => x.ruleId === "env-file")?.severity).toBe("BLOCKED");
    expect(f.find((x) => x.ruleId === "env-file")?.category).toBe("UNSUPPORTED");
  });

  it("rejects relative bind source as BLOCKED unsupported", () => {
    const f = findings("services:\n  app:\n    image: x\n    volumes:\n      - ./config:/config\n");
    expect(f.find((x) => x.ruleId === "relative-bind-source")?.severity).toBe("BLOCKED");
  });

  it("rejects build as BLOCKED unsupported", () => {
    const f = findings("services:\n  app:\n    build: .\n");
    expect(f.find((x) => x.ruleId === "build")?.severity).toBe("BLOCKED");
  });

  it("rejects include as BLOCKED unsupported", () => {
    const f = findings("include:\n  - other.yml\nservices:\n  app:\n    image: x\n");
    expect(f.find((x) => x.ruleId === "include")?.severity).toBe("BLOCKED");
  });

  it("rejects top-level secrets/configs as BLOCKED unsupported", () => {
    const f = findings("services:\n  app:\n    image: x\nsecrets:\n  s:\n    file: ./s.txt\nconfigs:\n  c:\n    file: ./c.txt\n");
    expect(f.find((x) => x.ruleId === "top-level-secrets")?.severity).toBe("BLOCKED");
    expect(f.find((x) => x.ruleId === "top-level-configs")?.severity).toBe("BLOCKED");
  });

  it("reports invalid YAML as INVALID BLOCKED", () => {
    const f = findings("services:\n  app: [unclosed\n");
    expect(f.find((x) => x.ruleId === "invalid-compose-yaml")?.severity).toBe("BLOCKED");
    expect(f.find((x) => x.ruleId === "invalid-compose-yaml")?.category).toBe("INVALID");
  });

  it("produces deterministic fingerprints independent of message text", () => {
    const fp1 = findingFingerprint({ analyzerVersion: "1", ruleId: "privileged", service: "web", resourcePath: "services.web.privileged", settingValue: "true" });
    const fp2 = findingFingerprint({ analyzerVersion: "1", ruleId: "privileged", service: "web", resourcePath: "services.web.privileged", settingValue: "true" });
    expect(fp1).toBe(fp2);
    expect(fp1).not.toBe(findingFingerprint({ analyzerVersion: "1", ruleId: "privileged", service: "db", resourcePath: "services.db.privileged", settingValue: "true" }));
  });

  it("secret sentinels are deterministic", () => {
    expect(secretSentinel("DB_PASSWORD")).toBe("__HOSTPANEL_SECRET_DB_PASSWORD__");
  });
});
