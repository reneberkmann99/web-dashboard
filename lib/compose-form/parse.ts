import { parse as parseYaml } from "yaml";
import {
  emptyForm,
  emptyHealthcheck,
  emptyResources,
  rowId,
  type ComposeForm,
  type EnvEntry,
  type HealthcheckForm,
  type NetworkAttachment,
  type PortEntry,
  type ResourcesForm,
  type ServiceForm,
  type TopLevelNetwork,
  type TopLevelVolume,
  type VolumeMount
} from "./model";

/**
 * Compose YAML → structured form model.
 *
 * Round-trip contract: every key the parser does not structurally understand
 * is copied verbatim into `unsupported` (per service) or `unsupportedTopLevel`
 * so `serializeForm(parseCompose(x))` preserves semantics.
 */

/** Service keys with a dedicated structured control. */
const HANDLED_SERVICE_KEYS = new Set([
  "image",
  "command",
  "entrypoint",
  "hostname",
  "working_dir",
  "user",
  "restart",
  "privileged",
  "read_only",
  "cap_add",
  "cap_drop",
  "ports",
  "environment",
  "networks",
  "volumes",
  "healthcheck",
  "labels",
  "depends_on",
  "mem_limit",
  "mem_reservation",
  "cpus",
  "container_name"
]);

const SECRET_REF_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]{0,127})\}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

export function parsePortString(raw: string): PortEntry {
  let rest = raw.trim();
  let protocol: "tcp" | "udp" = "tcp";
  const slash = rest.lastIndexOf("/");
  if (slash > -1) {
    const proto = rest.slice(slash + 1).toLowerCase();
    if (proto === "udp" || proto === "tcp") {
      protocol = proto;
      rest = rest.slice(0, slash);
    }
  }
  // IPv6 host IPs are bracketed: [::1]:8080:80
  let hostIp = "";
  if (rest.startsWith("[")) {
    const close = rest.indexOf("]");
    if (close > -1) {
      hostIp = rest.slice(1, close);
      rest = rest.slice(close + 2); // skip "]:"
    }
  }
  const parts = rest.split(":");
  if (hostIp) {
    if (parts.length >= 2) return { id: rowId("port"), hostIp, published: parts[0], target: parts[1], protocol };
    return { id: rowId("port"), hostIp, published: "", target: parts[0] ?? "", protocol };
  }
  if (parts.length === 3) {
    return { id: rowId("port"), hostIp: parts[0], published: parts[1], target: parts[2], protocol };
  }
  if (parts.length === 2) {
    return { id: rowId("port"), hostIp: "", published: parts[0], target: parts[1], protocol };
  }
  return { id: rowId("port"), hostIp: "", published: "", target: parts[0] ?? "", protocol };
}

function parsePorts(value: unknown): PortEntry[] {
  if (!Array.isArray(value)) return [];
  const out: PortEntry[] = [];
  for (const item of value) {
    if (typeof item === "string" || typeof item === "number") {
      out.push(parsePortString(String(item)));
    } else if (isRecord(item)) {
      const { target, published, protocol, host_ip: hostIp, ...extra } = item;
      out.push({
        id: rowId("port"),
        hostIp: asString(hostIp),
        published: asString(published),
        target: asString(target),
        protocol: asString(protocol).toLowerCase() === "udp" ? "udp" : "tcp",
        extra: Object.keys(extra).length > 0 ? extra : undefined
      });
    }
  }
  return out;
}

function parseEnvironment(value: unknown, secretReferences: string[]): { entries: EnvEntry[]; wasArray: boolean } {
  const secrets = new Set(secretReferences);
  const mark = (key: string, raw: string): EnvEntry => {
    const m = SECRET_REF_RE.exec(raw.trim());
    return { id: rowId("env"), key, value: raw, isSecret: Boolean(m && secrets.has(m[1])) };
  };
  if (Array.isArray(value)) {
    const entries: EnvEntry[] = [];
    for (const item of value) {
      const s = asString(item);
      const eq = s.indexOf("=");
      if (eq === -1) entries.push(mark(s, ""));
      else entries.push(mark(s.slice(0, eq), s.slice(eq + 1)));
    }
    return { entries, wasArray: true };
  }
  if (isRecord(value)) {
    return {
      entries: Object.entries(value).map(([k, v]) => mark(k, asString(v))),
      wasArray: false
    };
  }
  return { entries: [], wasArray: false };
}

function parseNetworks(value: unknown): NetworkAttachment[] {
  if (Array.isArray(value)) {
    return value.map((n) => ({ id: rowId("net"), name: asString(n), aliases: [] }));
  }
  if (isRecord(value)) {
    return Object.entries(value).map(([name, cfg]) => {
      if (!isRecord(cfg)) return { id: rowId("net"), name, aliases: [] };
      const { aliases, ...extra } = cfg;
      return {
        id: rowId("net"),
        name,
        aliases: Array.isArray(aliases) ? aliases.map(asString) : [],
        extra: Object.keys(extra).length > 0 ? extra : undefined
      };
    });
  }
  return [];
}

export function parseVolumeString(raw: string): VolumeMount {
  const s = raw.trim();
  // Split on ":" but tolerate windows-ish absolute paths minimally (not supported targets).
  const parts = s.split(":");
  let source = "";
  let target = "";
  let mode = "";
  if (parts.length === 1) {
    target = parts[0];
  } else if (parts.length === 2) {
    source = parts[0];
    target = parts[1];
  } else {
    source = parts[0];
    target = parts[1];
    mode = parts.slice(2).join(":");
  }
  const isBind = source.startsWith("/") || source.startsWith(".") || source.startsWith("~");
  return {
    id: rowId("vol"),
    kind: source === "" ? "volume" : isBind ? "bind" : "volume",
    source,
    target,
    readOnly: mode.split(",").includes("ro"),
    longForm: false
  };
}

function parseVolumes(value: unknown): VolumeMount[] {
  if (!Array.isArray(value)) return [];
  const out: VolumeMount[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      out.push(parseVolumeString(item));
    } else if (isRecord(item)) {
      const { type, source, target, read_only: readOnly, ...extra } = item;
      out.push({
        id: rowId("vol"),
        kind: asString(type) === "bind" ? "bind" : "volume",
        source: asString(source),
        target: asString(target),
        readOnly: readOnly === true,
        extra: Object.keys(extra).length > 0 ? extra : undefined,
        longForm: true
      });
    }
  }
  return out;
}

function parseHealthcheck(value: unknown): HealthcheckForm {
  if (!isRecord(value)) return emptyHealthcheck();
  const { test, interval, timeout, retries, start_period: startPeriod, disable, ...extra } = value;
  let testKind: HealthcheckForm["testKind"] = "none";
  let testStr = "";
  if (typeof test === "string") {
    testKind = "shell";
    testStr = test;
  } else if (Array.isArray(test)) {
    const arr = test.map(asString);
    if (arr[0] === "CMD-SHELL") {
      testKind = "shell";
      testStr = arr.slice(1).join(" ");
    } else if (arr[0] === "CMD") {
      testKind = "exec";
      testStr = arr.slice(1).join(" ");
    } else if (arr[0] === "NONE") {
      testKind = "none";
    } else {
      testKind = "exec";
      testStr = arr.join(" ");
    }
  }
  return {
    enabled: disable !== true && (testKind !== "none" || interval !== undefined),
    testKind,
    test: testStr,
    interval: asString(interval),
    timeout: asString(timeout),
    retries: asString(retries),
    startPeriod: asString(startPeriod),
    extra: Object.keys(extra).length > 0 ? extra : undefined
  };
}

/** Extract structured resource limits; returns the leftover `deploy` object. */
function parseResources(service: Record<string, unknown>): { resources: ResourcesForm; deployRemainder: unknown } {
  const res = emptyResources();
  const deploy = service.deploy;
  let deployRemainder: unknown = undefined;

  if (isRecord(deploy)) {
    const { resources, ...restDeploy } = deploy;
    if (isRecord(resources)) {
      const { limits, reservations, ...restResources } = resources;
      if (isRecord(limits)) {
        res.memoryLimit = asString(limits.memory);
        res.cpuLimit = asString(limits.cpus);
        const { memory: _m, cpus: _c, ...restLimits } = limits;
        if (Object.keys(restLimits).length > 0) {
          (restResources as Record<string, unknown>).limits = restLimits;
        }
      }
      if (isRecord(reservations)) {
        res.memoryReservation = asString(reservations.memory);
        res.cpuReservation = asString(reservations.cpus);
        const { memory: _m2, cpus: _c2, ...restRes } = reservations;
        if (Object.keys(restRes).length > 0) {
          (restResources as Record<string, unknown>).reservations = restRes;
        }
      }
      if (Object.keys(restResources).length > 0) {
        (restDeploy as Record<string, unknown>).resources = restResources;
      }
    } else if (resources !== undefined) {
      (restDeploy as Record<string, unknown>).resources = resources;
    }
    res.style = "deploy";
    if (Object.keys(restDeploy).length > 0) deployRemainder = restDeploy;
  }

  // Shorthand (non-swarm) limits take precedence for display when present.
  if (service.mem_limit !== undefined || service.cpus !== undefined || service.mem_reservation !== undefined) {
    if (service.mem_limit !== undefined) res.memoryLimit = asString(service.mem_limit);
    if (service.cpus !== undefined) res.cpuLimit = asString(service.cpus);
    if (service.mem_reservation !== undefined) res.memoryReservation = asString(service.mem_reservation);
    res.style = "shorthand";
  }

  return { resources: res, deployRemainder };
}

function parseLabels(value: unknown): { labels: ServiceForm["labels"]; wasArray: boolean } {
  if (Array.isArray(value)) {
    return {
      labels: value.map((item) => {
        const s = asString(item);
        const eq = s.indexOf("=");
        return eq === -1
          ? { id: rowId("lbl"), key: s, value: "" }
          : { id: rowId("lbl"), key: s.slice(0, eq), value: s.slice(eq + 1) };
      }),
      wasArray: true
    };
  }
  if (isRecord(value)) {
    return {
      labels: Object.entries(value).map(([k, v]) => ({ id: rowId("lbl"), key: k, value: asString(v) })),
      wasArray: false
    };
  }
  return { labels: [], wasArray: false };
}

function parseService(name: string, raw: unknown, secretReferences: string[]): ServiceForm {
  const svc = isRecord(raw) ? raw : {};
  const { resources, deployRemainder } = parseResources(svc);
  const env = parseEnvironment(svc.environment, secretReferences);
  const labels = parseLabels(svc.labels);

  const unsupported: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(svc)) {
    if (HANDLED_SERVICE_KEYS.has(k)) continue;
    if (k === "deploy") continue; // handled below via deployRemainder
    unsupported[k] = v;
  }
  if (deployRemainder !== undefined) unsupported.deploy = deployRemainder;
  if (svc.container_name !== undefined) unsupported.container_name = svc.container_name;

  return {
    id: rowId("svc"),
    name,
    image: asString(svc.image),
    command: Array.isArray(svc.command) ? svc.command.map(asString).join(" ") : asString(svc.command),
    entrypoint: Array.isArray(svc.entrypoint) ? svc.entrypoint.map(asString).join(" ") : asString(svc.entrypoint),
    hostname: asString(svc.hostname),
    workingDir: asString(svc.working_dir),
    user: asString(svc.user),
    restart: asString(svc.restart),
    privileged: svc.privileged === true,
    readOnly: svc.read_only === true,
    capAdd: Array.isArray(svc.cap_add) ? svc.cap_add.map(asString) : [],
    capDrop: Array.isArray(svc.cap_drop) ? svc.cap_drop.map(asString) : [],
    ports: parsePorts(svc.ports),
    environment: env.entries,
    networks: parseNetworks(svc.networks),
    volumes: parseVolumes(svc.volumes),
    healthcheck: parseHealthcheck(svc.healthcheck),
    resources,
    labels: labels.labels,
    dependsOn: Array.isArray(svc.depends_on)
      ? svc.depends_on.map(asString)
      : isRecord(svc.depends_on)
        ? Object.keys(svc.depends_on)
        : [],
    unsupported,
    commandWasArray: Array.isArray(svc.command),
    entrypointWasArray: Array.isArray(svc.entrypoint),
    commandRaw: svc.command,
    entrypointRaw: svc.entrypoint,
    environmentWasArray: env.wasArray,
    labelsWereArray: labels.wasArray
  };
}

function parseTopLevelNetworks(value: unknown): TopLevelNetwork[] {
  if (!isRecord(value)) return [];
  return Object.entries(value).map(([name, cfg]) => {
    if (!isRecord(cfg)) return { id: rowId("tnet"), name, external: false, driver: "", extra: {} };
    const { external, driver, ...extra } = cfg;
    return {
      id: rowId("tnet"),
      name,
      external: external === true || (isRecord(external) && external.name !== undefined),
      driver: asString(driver),
      extra: { ...(isRecord(external) ? { external } : {}), ...extra }
    };
  });
}

function parseTopLevelVolumes(value: unknown): TopLevelVolume[] {
  if (!isRecord(value)) return [];
  return Object.entries(value).map(([name, cfg]) => {
    if (!isRecord(cfg)) return { id: rowId("tvol"), name, external: false, driver: "", extra: {} };
    const { external, driver, ...extra } = cfg;
    return {
      id: rowId("tvol"),
      name,
      external: external === true || (isRecord(external) && external.name !== undefined),
      driver: asString(driver),
      extra: { ...(isRecord(external) ? { external } : {}), ...extra }
    };
  });
}

/**
 * Parse compose YAML into the structured form model.
 * `secretReferences` lets the parser mark `${KEY}` env values as secret refs.
 */
export function parseComposeToForm(source: string, secretReferences: string[] = []): ComposeForm {
  if (!source || source.trim().length === 0) return emptyForm();
  let root: unknown;
  try {
    root = parseYaml(source);
  } catch (e) {
    return { ...emptyForm(), parseError: e instanceof Error ? e.message : "Invalid YAML" };
  }
  if (!isRecord(root)) {
    return { ...emptyForm(), parseError: "Compose file must be a mapping at the top level." };
  }

  const servicesRaw = root.services;
  const services: ServiceForm[] = isRecord(servicesRaw)
    ? Object.entries(servicesRaw).map(([name, svc]) => parseService(name, svc, secretReferences))
    : [];

  const unsupportedTopLevel: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(root)) {
    if (k === "services" || k === "networks" || k === "volumes") continue;
    unsupportedTopLevel[k] = v;
  }

  return {
    services,
    networks: parseTopLevelNetworks(root.networks),
    volumes: parseTopLevelVolumes(root.volumes),
    unsupportedTopLevel,
    parseError: null
  };
}
