import { stringify as stringifyYaml } from "yaml";
import type {
  ComposeForm,
  HealthcheckForm,
  NetworkAttachment,
  PortEntry,
  ResourcesForm,
  ServiceForm,
  VolumeMount
} from "./model";

/**
 * Structured form model → Compose YAML.
 *
 * The output is fed straight into the EXISTING validate → revision → plan →
 * deploy pipeline; this module never talks to Docker or the database.
 * Unsupported keys captured at parse time are written back verbatim.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function serializePort(p: PortEntry): string | Record<string, unknown> {
  if (p.extra && Object.keys(p.extra).length > 0) {
    const obj: Record<string, unknown> = { ...p.extra };
    if (p.hostIp.trim()) obj.host_ip = p.hostIp.trim();
    if (p.published.trim()) obj.published = p.published.trim();
    obj.target = numberish(p.target.trim());
    obj.protocol = p.protocol;
    return obj;
  }
  const host = p.hostIp.trim();
  const published = p.published.trim();
  const target = p.target.trim();
  const proto = p.protocol === "udp" ? "/udp" : "";
  const ipPart = host ? (host.includes(":") ? `[${host}]:` : `${host}:`) : "";
  if (!published) return `${ipPart}${target}${proto}`;
  return `${ipPart}${published}:${target}${proto}`;
}

function numberish(value: string): string | number {
  return /^\d+$/.test(value) ? Number(value) : value;
}

function serializeVolume(v: VolumeMount): string | Record<string, unknown> {
  if (v.longForm || (v.extra && Object.keys(v.extra).length > 0)) {
    const obj: Record<string, unknown> = { ...(v.extra ?? {}) };
    obj.type = v.kind;
    if (v.source.trim()) obj.source = v.source.trim();
    obj.target = v.target.trim();
    if (v.readOnly) obj.read_only = true;
    return obj;
  }
  const src = v.source.trim();
  const tgt = v.target.trim();
  const ro = v.readOnly ? ":ro" : "";
  if (!src) return `${tgt}`;
  return `${src}:${tgt}${ro}`;
}

function serializeNetworks(nets: NetworkAttachment[]): unknown {
  if (nets.length === 0) return undefined;
  const needsLongForm = nets.some((n) => n.aliases.length > 0 || (n.extra && Object.keys(n.extra).length > 0));
  if (!needsLongForm) return nets.map((n) => n.name.trim()).filter(Boolean);
  const obj: Record<string, unknown> = {};
  for (const n of nets) {
    const name = n.name.trim();
    if (!name) continue;
    const cfg: Record<string, unknown> = { ...(n.extra ?? {}) };
    const aliases = n.aliases.map((a) => a.trim()).filter(Boolean);
    if (aliases.length > 0) cfg.aliases = aliases;
    obj[name] = Object.keys(cfg).length > 0 ? cfg : null;
  }
  return obj;
}

function serializeHealthcheck(hc: HealthcheckForm): Record<string, unknown> | undefined {
  if (!hc.enabled) return undefined;
  const out: Record<string, unknown> = { ...(hc.extra ?? {}) };
  const test = hc.test.trim();
  if (hc.testKind === "shell" && test) out.test = ["CMD-SHELL", test];
  else if (hc.testKind === "exec" && test) out.test = ["CMD", ...test.split(/\s+/)];
  else if (hc.testKind === "none") out.test = ["NONE"];
  if (hc.interval.trim()) out.interval = hc.interval.trim();
  if (hc.timeout.trim()) out.timeout = hc.timeout.trim();
  if (hc.retries.trim()) out.retries = numberish(hc.retries.trim());
  if (hc.startPeriod.trim()) out.start_period = hc.startPeriod.trim();
  return Object.keys(out).length > 0 ? out : undefined;
}

function applyResources(target: Record<string, unknown>, res: ResourcesForm, unsupportedDeploy: unknown): void {
  const mem = res.memoryLimit.trim();
  const cpu = res.cpuLimit.trim();
  const memRes = res.memoryReservation.trim();
  const cpuRes = res.cpuReservation.trim();

  if (res.style === "shorthand") {
    if (mem) target.mem_limit = mem;
    if (cpu) target.cpus = numberish(cpu);
    if (memRes) target.mem_reservation = memRes;
    if (isRecord(unsupportedDeploy) && Object.keys(unsupportedDeploy).length > 0) {
      target.deploy = unsupportedDeploy;
    }
    return;
  }

  const limits: Record<string, unknown> = {};
  if (mem) limits.memory = mem;
  if (cpu) limits.cpus = cpu;
  const reservations: Record<string, unknown> = {};
  if (memRes) reservations.memory = memRes;
  if (cpuRes) reservations.cpus = cpuRes;

  const deployBase: Record<string, unknown> = isRecord(unsupportedDeploy) ? { ...unsupportedDeploy } : {};
  const resourcesBase: Record<string, unknown> = isRecord(deployBase.resources)
    ? { ...(deployBase.resources as Record<string, unknown>) }
    : {};

  if (Object.keys(limits).length > 0) {
    resourcesBase.limits = { ...(isRecord(resourcesBase.limits) ? resourcesBase.limits : {}), ...limits };
  }
  if (Object.keys(reservations).length > 0) {
    resourcesBase.reservations = {
      ...(isRecord(resourcesBase.reservations) ? resourcesBase.reservations : {}),
      ...reservations
    };
  }
  if (Object.keys(resourcesBase).length > 0) deployBase.resources = resourcesBase;
  if (Object.keys(deployBase).length > 0) target.deploy = deployBase;
}

export function serializeService(svc: ServiceForm): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  if (svc.image.trim()) out.image = svc.image.trim();

  if (svc.command.trim()) {
    const joinedOriginal = Array.isArray(svc.commandRaw)
      ? (svc.commandRaw as unknown[]).map((v) => String(v)).join(" ")
      : null;
    if (svc.commandWasArray && joinedOriginal === svc.command) out.command = svc.commandRaw;
    else if (svc.commandWasArray) out.command = svc.command.trim().split(/\s+/);
    else out.command = svc.command.trim();
  }
  if (svc.entrypoint.trim()) {
    const joinedOriginal = Array.isArray(svc.entrypointRaw)
      ? (svc.entrypointRaw as unknown[]).map((v) => String(v)).join(" ")
      : null;
    if (svc.entrypointWasArray && joinedOriginal === svc.entrypoint) out.entrypoint = svc.entrypointRaw;
    else if (svc.entrypointWasArray) out.entrypoint = svc.entrypoint.trim().split(/\s+/);
    else out.entrypoint = svc.entrypoint.trim();
  }

  if (svc.hostname.trim()) out.hostname = svc.hostname.trim();
  if (svc.workingDir.trim()) out.working_dir = svc.workingDir.trim();
  if (svc.user.trim()) out.user = svc.user.trim();
  if (svc.restart.trim()) out.restart = svc.restart.trim();
  if (svc.privileged) out.privileged = true;
  if (svc.readOnly) out.read_only = true;

  const capAdd = svc.capAdd.map((c) => c.trim()).filter(Boolean);
  if (capAdd.length > 0) out.cap_add = capAdd;
  const capDrop = svc.capDrop.map((c) => c.trim()).filter(Boolean);
  if (capDrop.length > 0) out.cap_drop = capDrop;

  const ports = svc.ports.filter((p) => p.target.trim()).map(serializePort);
  if (ports.length > 0) out.ports = ports;

  const envEntries = svc.environment.filter((e) => e.key.trim());
  if (envEntries.length > 0) {
    if (svc.environmentWasArray) {
      out.environment = envEntries.map((e) => `${e.key.trim()}=${e.value}`);
    } else {
      const env: Record<string, string> = {};
      for (const e of envEntries) env[e.key.trim()] = e.value;
      out.environment = env;
    }
  }

  const nets = serializeNetworks(svc.networks);
  if (nets !== undefined) out.networks = nets;

  const vols = svc.volumes.filter((v) => v.target.trim()).map(serializeVolume);
  if (vols.length > 0) out.volumes = vols;

  const hc = serializeHealthcheck(svc.healthcheck);
  if (hc) out.healthcheck = hc;

  const labels = svc.labels.filter((l) => l.key.trim());
  if (labels.length > 0) {
    if (svc.labelsWereArray) out.labels = labels.map((l) => `${l.key.trim()}=${l.value}`);
    else {
      const obj: Record<string, string> = {};
      for (const l of labels) obj[l.key.trim()] = l.value;
      out.labels = obj;
    }
  }

  if (svc.dependsOn.length > 0) out.depends_on = svc.dependsOn.map((d) => d.trim()).filter(Boolean);

  const { deploy: unsupportedDeploy, ...restUnsupported } = svc.unsupported;
  applyResources(out, svc.resources, unsupportedDeploy);

  for (const [k, v] of Object.entries(restUnsupported)) {
    out[k] = v;
  }

  return out;
}

export function serializeForm(form: ComposeForm): string {
  const root: Record<string, unknown> = { ...form.unsupportedTopLevel };

  const services: Record<string, unknown> = {};
  for (const svc of form.services) {
    const name = svc.name.trim();
    if (!name) continue;
    services[name] = serializeService(svc);
  }
  root.services = services;

  if (form.networks.length > 0) {
    const nets: Record<string, unknown> = {};
    for (const n of form.networks) {
      const name = n.name.trim();
      if (!name) continue;
      const cfg: Record<string, unknown> = { ...n.extra };
      if (n.external && cfg.external === undefined) cfg.external = true;
      if (n.driver.trim()) cfg.driver = n.driver.trim();
      nets[name] = Object.keys(cfg).length > 0 ? cfg : null;
    }
    root.networks = nets;
  }

  if (form.volumes.length > 0) {
    const vols: Record<string, unknown> = {};
    for (const v of form.volumes) {
      const name = v.name.trim();
      if (!name) continue;
      const cfg: Record<string, unknown> = { ...v.extra };
      if (v.external && cfg.external === undefined) cfg.external = true;
      if (v.driver.trim()) cfg.driver = v.driver.trim();
      vols[name] = Object.keys(cfg).length > 0 ? cfg : null;
    }
    root.volumes = vols;
  }

  // Keep `services` first for readability while preserving other top-level keys.
  const ordered: Record<string, unknown> = { services: root.services };
  if (root.networks !== undefined) ordered.networks = root.networks;
  if (root.volumes !== undefined) ordered.volumes = root.volumes;
  for (const [k, v] of Object.entries(root)) {
    if (k === "services" || k === "networks" || k === "volumes") continue;
    ordered[k] = v;
  }

  return stringifyYaml(ordered, { lineWidth: 0 });
}
