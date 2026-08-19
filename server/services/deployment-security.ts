import crypto from "node:crypto";
import { parse } from "yaml";
import { FindingCategory, FindingSeverity } from "@prisma/client";

/**
 * Compose security / policy analyzer (Stage A of managed-deployment validation).
 *
 * Runs entirely in the control plane, WITHOUT `docker compose` and WITHOUT any
 * real secret values. It parses the HostPanel-authored Compose source (YAML)
 * and produces findings classified by category + severity:
 *
 *   category SECURITY     -> severity INFO | WARNING | HIGH_RISK | BLOCKED
 *   category UNSUPPORTED  -> severity BLOCKED (v1 does not support the feature)
 *   category INVALID      -> severity BLOCKED (unparseable input)
 *
 * Every finding has a deterministic fingerprint derived from stable properties
 * (analyzerVersion, ruleId, service, resourcePath, settingValue) — never from
 * the English message text — so an acknowledgement can never silently cover a
 * materially different finding.
 */

export const ANALYZER_VERSION = "1";

export type SecurityFinding = {
  ruleId: string;
  severity: FindingSeverity;
  category: FindingCategory;
  service: string | null;
  resourcePath: string | null;
  settingValue: string | null;
  message: string;
  fingerprint: string;
  analyzerVersion: string;
};

/** Deterministic sentinel used in place of a real secret during validation. */
export function secretSentinel(key: string): string {
  return `__HOSTPANEL_SECRET_${key}__`;
}

export function findingFingerprint(input: {
  analyzerVersion: string;
  ruleId: string;
  service?: string | null;
  resourcePath?: string | null;
  settingValue?: string | null;
}): string {
  const parts = [
    input.analyzerVersion,
    input.ruleId,
    input.service ?? "",
    input.resourcePath ?? "",
    input.settingValue ?? ""
  ];
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex");
}

const INTERPOLATION_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)[^}]*\}/g;

type RefLocation = { varName: string; path: string[] };

function collectInterpolationRefs(node: unknown, path: string[], out: RefLocation[]): void {
  if (typeof node === "string") {
    let m: RegExpExecArray | null;
    INTERPOLATION_RE.lastIndex = 0;
    while ((m = INTERPOLATION_RE.exec(node)) !== null) {
      out.push({ varName: m[1], path: path.slice() });
    }
    return;
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      collectInterpolationRefs(node[i], [...path, String(i)], out);
    }
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      collectInterpolationRefs(v, [...path, k], out);
    }
  }
}

const SENSITIVE_BIND_ROOTS = [
  "/",
  "/etc",
  "/root",
  "/home",
  "/var",
  "/proc",
  "/sys",
  "/boot",
  "/usr",
  "/lib",
  "/bin",
  "/sbin",
  "/opt",
  "/dev",
  "/mnt",
  "/media",
  "/run",
  "/srv"
];

const DANGEROUS_CAPS = new Set([
  "ALL",
  "SYS_ADMIN",
  "SYS_PTRACE",
  "SYS_MODULE",
  "SYS_RAWIO",
  "SYS_BOOT",
  "SYSLOG",
  "WAKE_ALARM",
  "BLOCK_SUSPEND",
  "BPF",
  "PERFMON",
  "CHECKPOINT_RESTORE",
  "DAC_READ_SEARCH",
  "DAC_OVERRIDE",
  "MAC_ADMIN",
  "MAC_OVERRIDE",
  "SETFCAP",
  "SETPCAP",
  "AUDIT_CONTROL"
]);

function isSensitiveBindSource(source: string): boolean {
  if (source === "~" || source.startsWith("~/")) return true;
  return SENSITIVE_BIND_ROOTS.some(
    (root) => source === root || source.startsWith(root + "/")
  );
}

function isDockerSocket(source: string): boolean {
  return source.includes("docker.sock");
}

type AnalyzerCtx = {
  findings: SecurityFinding[];
};

function push(
  ctx: AnalyzerCtx,
  input: {
    ruleId: string;
    severity: FindingSeverity;
    category: FindingCategory;
    service?: string | null;
    resourcePath?: string | null;
    settingValue?: string | null;
    message: string;
  }
): void {
  ctx.findings.push({
    ruleId: input.ruleId,
    severity: input.severity,
    category: input.category,
    service: input.service ?? null,
    resourcePath: input.resourcePath ?? null,
    settingValue: input.settingValue ?? null,
    message: input.message,
    analyzerVersion: ANALYZER_VERSION,
    fingerprint: findingFingerprint({
      analyzerVersion: ANALYZER_VERSION,
      ruleId: input.ruleId,
      service: input.service,
      resourcePath: input.resourcePath,
      settingValue: input.settingValue
    })
  });
}

function analyzeVolumeMount(
  ctx: AnalyzerCtx,
  serviceName: string,
  mount: unknown
): void {
  let source: string | null = null;
  let kind: "bind" | "volume" | "tmpfs" | "unknown" = "unknown";

  if (typeof mount === "string") {
    const first = mount.split(":")[0] ?? "";
    if (first === "") return; // anonymous volume ":/path"
    source = first;
    kind =
      first.startsWith("/") || first.startsWith(".") || first.startsWith("~")
        ? "bind"
        : "volume";
  } else if (mount && typeof mount === "object") {
    const m = mount as { type?: string; source?: string };
    source = typeof m.source === "string" ? m.source : null;
    kind = m.type === "bind" ? "bind" : m.type === "tmpfs" ? "tmpfs" : "volume";
  }

  if (source == null || kind === "tmpfs") return;

  const resourcePath = `services.${serviceName}.volumes`;

  if (kind === "bind") {
    if (
      source === "." ||
      source === ".." ||
      source.startsWith("./") ||
      source.startsWith("../")
    ) {
      push(ctx, {
        ruleId: "relative-bind-source",
        severity: "BLOCKED",
        category: "UNSUPPORTED",
        service: serviceName,
        resourcePath,
        settingValue: source,
        message: `Relative bind source "${source}" is not supported by HostPanel managed deployments yet. Use an absolute host path or a named Docker volume.`
      });
      return;
    }
  }

  if (isDockerSocket(source)) {
    push(ctx, {
      ruleId: "docker-socket-mount",
      severity: "HIGH_RISK",
      category: "SECURITY",
      service: serviceName,
      resourcePath,
      settingValue: source,
      message: `Service "${serviceName}" mounts the Docker socket (${source}), giving the container control over the Docker daemon.`
    });
    return;
  }

  if (kind === "bind" && isSensitiveBindSource(source)) {
    push(ctx, {
      ruleId: "sensitive-host-bind",
      severity: "HIGH_RISK",
      category: "SECURITY",
      service: serviceName,
      resourcePath,
      settingValue: source,
      message: `Service "${serviceName}" bind-mounts a sensitive host path (${source}).`
    });
  }
}

function analyzeService(
  ctx: AnalyzerCtx,
  serviceName: string,
  svc: unknown
): void {
  if (!svc || typeof svc !== "object") return;
  const s = svc as Record<string, unknown>;
  const base = `services.${serviceName}`;

  if (s.privileged === true) {
    push(ctx, {
      ruleId: "privileged",
      severity: "HIGH_RISK",
      category: "SECURITY",
      service: serviceName,
      resourcePath: `${base}.privileged`,
      settingValue: "true",
      message: `Service "${serviceName}" runs privileged, granting it broad host access.`
    });
  }

  if (s.network_mode === "host") {
    push(ctx, {
      ruleId: "host-networking",
      severity: "HIGH_RISK",
      category: "SECURITY",
      service: serviceName,
      resourcePath: `${base}.network_mode`,
      settingValue: "host",
      message: `Service "${serviceName}" uses host networking.`
    });
  }

  if (s.pid === "host") {
    push(ctx, {
      ruleId: "pid-host",
      severity: "HIGH_RISK",
      category: "SECURITY",
      service: serviceName,
      resourcePath: `${base}.pid`,
      settingValue: "host",
      message: `Service "${serviceName}" shares the host PID namespace.`
    });
  }

  if (s.ipc === "host") {
    push(ctx, {
      ruleId: "ipc-host",
      severity: "WARNING",
      category: "SECURITY",
      service: serviceName,
      resourcePath: `${base}.ipc`,
      settingValue: "host",
      message: `Service "${serviceName}" shares the host IPC namespace.`
    });
  }

  if (Array.isArray(s.cap_add) && s.cap_add.length > 0) {
    const caps = s.cap_add.map(String);
    const dangerous = caps.filter((c) => DANGEROUS_CAPS.has(c.toUpperCase()));
    if (dangerous.length > 0) {
      push(ctx, {
        ruleId: "cap-add",
        severity: "HIGH_RISK",
        category: "SECURITY",
        service: serviceName,
        resourcePath: `${base}.cap_add`,
        settingValue: dangerous.join(","),
        message: `Service "${serviceName}" adds dangerous Linux capabilities: ${dangerous.join(", ")}.`
      });
    } else {
      push(ctx, {
        ruleId: "cap-add",
        severity: "WARNING",
        category: "SECURITY",
        service: serviceName,
        resourcePath: `${base}.cap_add`,
        settingValue: caps.join(","),
        message: `Service "${serviceName}" adds Linux capabilities: ${caps.join(", ")}.`
      });
    }
  }

  if (Array.isArray(s.devices) && s.devices.length > 0) {
    push(ctx, {
      ruleId: "devices",
      severity: "HIGH_RISK",
      category: "SECURITY",
      service: serviceName,
      resourcePath: `${base}.devices`,
      settingValue: s.devices.map(String).join(","),
      message: `Service "${serviceName}" exposes host devices to the container.`
    });
  }

  if (Array.isArray(s.security_opt) && s.security_opt.length > 0) {
    const opts = s.security_opt.map(String);
    const unrestricted = opts.some((o) =>
      /^(seccomp|apparmor)[:=](unconfined|unconfined)$/i.test(o) || /unconfined/i.test(o)
    );
    push(ctx, {
      ruleId: "security-opt",
      severity: unrestricted ? "HIGH_RISK" : "WARNING",
      category: "SECURITY",
      service: serviceName,
      resourcePath: `${base}.security_opt`,
      settingValue: opts.join(","),
      message: `Service "${serviceName}" overrides security options: ${opts.join(", ")}.`
    });
  }

  if (Array.isArray(s.volumes)) {
    for (const m of s.volumes) analyzeVolumeMount(ctx, serviceName, m);
  }

  if (Array.isArray(s.ports) && s.ports.length > 0) {
    push(ctx, {
      ruleId: "published-ports",
      severity: "INFO",
      category: "SECURITY",
      service: serviceName,
      resourcePath: `${base}.ports`,
      settingValue: s.ports.map(String).join(","),
      message: `Service "${serviceName}" publishes ports: ${s.ports.map(String).join(", ")}.`
    });
  }

  if (s.env_file !== undefined && s.env_file !== null) {
    push(ctx, {
      ruleId: "env-file",
      severity: "BLOCKED",
      category: "UNSUPPORTED",
      service: serviceName,
      resourcePath: `${base}.env_file`,
      settingValue: JSON.stringify(s.env_file),
      message: `Service "${serviceName}" uses env_file, which is not supported by HostPanel managed deployments yet.`
    });
  }

  if (s.build !== undefined && s.build !== null) {
    push(ctx, {
      ruleId: "build",
      severity: "BLOCKED",
      category: "UNSUPPORTED",
      service: serviceName,
      resourcePath: `${base}.build`,
      settingValue: null,
      message: `Service "${serviceName}" uses build, which is not supported by HostPanel managed deployments yet (HostPanel pulls images only).`
    });
  }

  if (s.dns !== undefined || s.dns_search !== undefined) {
    push(ctx, {
      ruleId: "custom-dns",
      severity: "INFO",
      category: "SECURITY",
      service: serviceName,
      resourcePath: `${base}.dns`,
      settingValue: s.dns ? JSON.stringify(s.dns) : null,
      message: `Service "${serviceName}" configures custom DNS.`
    });
  }

  if (s.sysctls !== undefined && s.sysctls !== null) {
    push(ctx, {
      ruleId: "sysctls",
      severity: "WARNING",
      category: "SECURITY",
      service: serviceName,
      resourcePath: `${base}.sysctls`,
      settingValue: JSON.stringify(s.sysctls),
      message: `Service "${serviceName}" configures kernel sysctls.`
    });
  }
}

function analyzeExternalResources(
  ctx: AnalyzerCtx,
  section: "networks" | "volumes",
  root: Record<string, unknown>
): void {
  const value = root[section];
  if (!value || typeof value !== "object") return;
  for (const [name, def] of Object.entries(value as Record<string, unknown>)) {
    if (def && typeof def === "object" && (def as Record<string, unknown>).external) {
      push(ctx, {
        ruleId: `external-${section}`,
        severity: "INFO",
        category: "SECURITY",
        service: null,
        resourcePath: `${section}.${name}`,
        settingValue: "external",
        message: `${section === "networks" ? "Network" : "Volume"} "${name}" is external and will not be managed.`
      });
    }
  }
}

export type AnalyzeResult = {
  findings: SecurityFinding[];
  /** True when the Compose source could be parsed as YAML at all. */
  parseOk: boolean;
  parseError: string | null;
};

/**
 * Analyze the HostPanel-authored Compose source. Returns findings (possibly
 * empty). Never touches the network, Docker, or secret values.
 */
export function analyzeComposeDefinition(input: {
  composeSource: string;
  secretReferences: string[];
}): AnalyzeResult {
  let root: unknown;
  try {
    root = parse(input.composeSource);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid YAML";
    return {
      parseOk: false,
      parseError: message,
      findings: [
        {
          ruleId: "invalid-compose-yaml",
          severity: "BLOCKED",
          category: "INVALID",
          service: null,
          resourcePath: null,
          settingValue: null,
          message: `Compose source is not valid YAML: ${message}`,
          analyzerVersion: ANALYZER_VERSION,
          fingerprint: findingFingerprint({
            analyzerVersion: ANALYZER_VERSION,
            ruleId: "invalid-compose-yaml"
          })
        }
      ]
    };
  }

  const ctx: AnalyzerCtx = { findings: [] };
  const obj = (root && typeof root === "object" ? root : {}) as Record<string, unknown>;

  // Top-level unsupported file-backed features.
  if (obj.include !== undefined && obj.include !== null) {
    push(ctx, {
      ruleId: "include",
      severity: "BLOCKED",
      category: "UNSUPPORTED",
      resourcePath: "include",
      message: "Compose `include` fragments are not supported by HostPanel managed deployments yet."
    });
  }
  if (obj.secrets !== undefined && obj.secrets !== null) {
    push(ctx, {
      ruleId: "top-level-secrets",
      severity: "BLOCKED",
      category: "UNSUPPORTED",
      resourcePath: "secrets",
      message: "Top-level Compose `secrets` (file-backed) are not supported. Use HostPanel managed secrets instead."
    });
  }
  if (obj.configs !== undefined && obj.configs !== null) {
    push(ctx, {
      ruleId: "top-level-configs",
      severity: "BLOCKED",
      category: "UNSUPPORTED",
      resourcePath: "configs",
      message: "Top-level Compose `configs` (file-backed) are not supported by HostPanel managed deployments yet."
    });
  }

  // Secret interpolation must only occur within service environment values.
  const refs: RefLocation[] = [];
  collectInterpolationRefs(root, [], refs);
  const secretKeys = new Set(input.secretReferences);
  for (const ref of refs) {
    if (!secretKeys.has(ref.varName)) continue;
    const inEnvironment =
      ref.path[0] === "services" && ref.path[2] === "environment";
    if (!inEnvironment) {
      push(ctx, {
        ruleId: "secret-interpolation-outside-environment",
        severity: "BLOCKED",
        category: "UNSUPPORTED",
        service: typeof ref.path[1] === "string" ? ref.path[1] : null,
        resourcePath: ref.path.join("."),
        settingValue: ref.varName,
        message: `Secret "${ref.varName}" is referenced outside a service environment value (at ${ref.path.join(".")}). HostPanel managed secrets may only supply service environment values in v1.`
      });
    }
  }

  // Per-service structural checks.
  const services = obj.services;
  if (services && typeof services === "object") {
    for (const [name, svc] of Object.entries(services as Record<string, unknown>)) {
      analyzeService(ctx, name, svc);
    }
  }

  analyzeExternalResources(ctx, "networks", obj);
  analyzeExternalResources(ctx, "volumes", obj);

  return { findings: ctx.findings, parseOk: true, parseError: null };
}

/**
 * Findings that block revision creation outright (cannot be acknowledged).
 */
export function hasBlockingFindings(findings: SecurityFinding[]): boolean {
  return findings.some((f) => f.severity === "BLOCKED");
}

/**
 * HIGH_RISK findings that require an explicit ADMIN acknowledgement.
 */
export function highRiskFindings(findings: SecurityFinding[]): SecurityFinding[] {
  return findings.filter((f) => f.severity === "HIGH_RISK");
}
