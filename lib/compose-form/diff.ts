import { parseComposeToForm } from "./parse";
import { serializePort } from "./serialize";
import type { ComposeForm, ServiceForm } from "./model";

/**
 * Structured, field-level change list between two compose definitions.
 *
 * Produces human-readable entries like
 *   "Image  nginx:1.28 → nginx:1.29"
 *   "Port   8080:80/tcp → 8081:80/tcp"
 *
 * SECURITY: secret VALUES never appear here. Environment entries whose value is
 * a `${KEY}` secret interpolation are rendered as the key name plus a
 * "secret reference" marker; any value belonging to a declared secret reference
 * is redacted to `••••••`.
 */

export type FieldChangeKind = "added" | "removed" | "changed";

export type FieldChange = {
  kind: FieldChangeKind;
  /** e.g. "Image", "Port", "Environment", "Volume", "Network", "Healthcheck". */
  field: string;
  before: string | null;
  after: string | null;
};

export type ServiceChangeSet = {
  serviceName: string;
  kind: "added" | "removed" | "changed" | "unchanged";
  changes: FieldChange[];
};

export type StructuredDiff = {
  services: ServiceChangeSet[];
  networks: FieldChange[];
  volumes: FieldChange[];
  /** True when nothing structural differs (may still differ in formatting). */
  empty: boolean;
};

const REDACTED = "••••••";

function envDisplay(key: string, value: string, secretKeys: Set<string>): string {
  const m = /^\$\{([A-Za-z_][A-Za-z0-9_]{0,127})\}$/.exec(value.trim());
  if (m && secretKeys.has(m[1])) return `${key}=<secret ${m[1]}>`;
  if (secretKeys.has(key)) return `${key}=${REDACTED}`;
  return `${key}=${value}`;
}

function portDisplay(p: ServiceForm["ports"][number]): string {
  const s = serializePort(p);
  return typeof s === "string" ? s : JSON.stringify(s);
}

function volumeDisplay(v: ServiceForm["volumes"][number]): string {
  const ro = v.readOnly ? ":ro" : "";
  return v.source ? `${v.source} → ${v.target}${ro} (${v.kind})` : `${v.target}${ro} (anonymous ${v.kind})`;
}

function networkDisplay(n: ServiceForm["networks"][number]): string {
  return n.aliases.length > 0 ? `${n.name} (aliases: ${n.aliases.join(", ")})` : n.name;
}

function healthcheckDisplay(hc: ServiceForm["healthcheck"]): string {
  if (!hc.enabled) return "disabled";
  const parts = [hc.testKind === "none" ? "NONE" : hc.test];
  if (hc.interval) parts.push(`interval ${hc.interval}`);
  if (hc.timeout) parts.push(`timeout ${hc.timeout}`);
  if (hc.retries) parts.push(`retries ${hc.retries}`);
  if (hc.startPeriod) parts.push(`start_period ${hc.startPeriod}`);
  return parts.filter(Boolean).join(", ");
}

function resourcesDisplay(r: ServiceForm["resources"]): string {
  const parts: string[] = [];
  if (r.memoryLimit) parts.push(`memory ${r.memoryLimit}`);
  if (r.cpuLimit) parts.push(`cpus ${r.cpuLimit}`);
  if (r.memoryReservation) parts.push(`memory reservation ${r.memoryReservation}`);
  if (r.cpuReservation) parts.push(`cpu reservation ${r.cpuReservation}`);
  return parts.length > 0 ? parts.join(", ") : "unset";
}

function scalarChange(field: string, before: string, after: string, out: FieldChange[]): void {
  const b = before.trim();
  const a = after.trim();
  if (b === a) return;
  out.push({
    kind: !b ? "added" : !a ? "removed" : "changed",
    field,
    before: b || null,
    after: a || null
  });
}

function listChange<T>(
  field: string,
  before: T[],
  after: T[],
  display: (item: T) => string,
  keyOf: (item: T) => string,
  out: FieldChange[]
): void {
  const beforeMap = new Map(before.map((i) => [keyOf(i), display(i)]));
  const afterMap = new Map(after.map((i) => [keyOf(i), display(i)]));
  for (const [key, beforeText] of beforeMap) {
    const afterText = afterMap.get(key);
    if (afterText === undefined) {
      out.push({ kind: "removed", field, before: beforeText, after: null });
    } else if (afterText !== beforeText) {
      out.push({ kind: "changed", field, before: beforeText, after: afterText });
    }
  }
  for (const [key, afterText] of afterMap) {
    if (!beforeMap.has(key)) out.push({ kind: "added", field, before: null, after: afterText });
  }
}

function diffService(before: ServiceForm, after: ServiceForm, secretKeys: Set<string>): FieldChange[] {
  const out: FieldChange[] = [];

  scalarChange("Image", before.image, after.image, out);
  scalarChange("Command", before.command, after.command, out);
  scalarChange("Entrypoint", before.entrypoint, after.entrypoint, out);
  scalarChange("Hostname", before.hostname, after.hostname, out);
  scalarChange("Working directory", before.workingDir, after.workingDir, out);
  scalarChange("User", before.user, after.user, out);
  scalarChange("Restart policy", before.restart, after.restart, out);
  scalarChange("Privileged", String(before.privileged), String(after.privileged), out);
  scalarChange("Read-only root filesystem", String(before.readOnly), String(after.readOnly), out);
  scalarChange("Capabilities added", before.capAdd.join(", "), after.capAdd.join(", "), out);
  scalarChange("Capabilities dropped", before.capDrop.join(", "), after.capDrop.join(", "), out);

  listChange("Port", before.ports, after.ports, portDisplay, (p) => `${p.target}/${p.protocol}`, out);
  listChange(
    "Environment",
    before.environment,
    after.environment,
    (e) => envDisplay(e.key, e.value, secretKeys),
    (e) => e.key,
    out
  );
  listChange("Network", before.networks, after.networks, networkDisplay, (n) => n.name, out);
  listChange("Volume", before.volumes, after.volumes, volumeDisplay, (v) => v.target, out);
  listChange(
    "Label",
    before.labels,
    after.labels,
    (l) => `${l.key}=${l.value}`,
    (l) => l.key,
    out
  );

  scalarChange("Healthcheck", healthcheckDisplay(before.healthcheck), healthcheckDisplay(after.healthcheck), out);
  scalarChange("Resources", resourcesDisplay(before.resources), resourcesDisplay(after.resources), out);
  scalarChange("Depends on", before.dependsOn.join(", "), after.dependsOn.join(", "), out);

  const beforeUnsupported = JSON.stringify(before.unsupported);
  const afterUnsupported = JSON.stringify(after.unsupported);
  if (beforeUnsupported !== afterUnsupported) {
    out.push({
      kind: "changed",
      field: "Advanced (unsupported options)",
      before: "previous value",
      after: "updated value"
    });
  }

  return out;
}

function serviceSummary(svc: ServiceForm): string {
  return svc.image || "(no image)";
}

export function diffForms(before: ComposeForm, after: ComposeForm, secretReferences: string[] = []): StructuredDiff {
  const secretKeys = new Set(secretReferences);
  const beforeByName = new Map(before.services.map((s) => [s.name, s]));
  const afterByName = new Map(after.services.map((s) => [s.name, s]));
  const names = Array.from(new Set([...beforeByName.keys(), ...afterByName.keys()])).sort();

  const services: ServiceChangeSet[] = [];
  for (const name of names) {
    const b = beforeByName.get(name);
    const a = afterByName.get(name);
    if (b && a) {
      const changes = diffService(b, a, secretKeys);
      services.push({ serviceName: name, kind: changes.length > 0 ? "changed" : "unchanged", changes });
    } else if (a) {
      services.push({
        serviceName: name,
        kind: "added",
        changes: [{ kind: "added", field: "Service", before: null, after: serviceSummary(a) }]
      });
    } else if (b) {
      services.push({
        serviceName: name,
        kind: "removed",
        changes: [{ kind: "removed", field: "Service", before: serviceSummary(b), after: null }]
      });
    }
  }

  const networks: FieldChange[] = [];
  listChange(
    "Network",
    before.networks,
    after.networks,
    (n) => `${n.name}${n.external ? " (external)" : ""}${n.driver ? ` driver=${n.driver}` : ""}`,
    (n) => n.name,
    networks
  );

  const volumes: FieldChange[] = [];
  listChange(
    "Volume",
    before.volumes,
    after.volumes,
    (v) => `${v.name}${v.external ? " (external)" : ""}${v.driver ? ` driver=${v.driver}` : ""}`,
    (v) => v.name,
    volumes
  );

  const empty =
    services.every((s) => s.kind === "unchanged") && networks.length === 0 && volumes.length === 0;

  return { services, networks, volumes, empty };
}

/** Convenience: diff two compose YAML strings structurally. */
export function diffComposeSources(
  before: string,
  after: string,
  secretReferences: string[] = []
): StructuredDiff {
  return diffForms(
    parseComposeToForm(before, secretReferences),
    parseComposeToForm(after, secretReferences),
    secretReferences
  );
}
