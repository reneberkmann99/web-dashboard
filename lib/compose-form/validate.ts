import type { ComposeForm, ServiceForm } from "./model";

/**
 * Client-side inline validation for the structured form.
 *
 * UX layer ONLY. The authoritative validation stays server-side
 * (`/api/{admin,client}/deployments/validate` → `docker compose config` via the
 * node agent + the security analyzer). Nothing here is ever trusted for
 * authorization or safety decisions.
 */

export type FormIssue = {
  severity: "error" | "warning";
  /** Dotted path for focusing the offending control, e.g. "services.web.ports.0". */
  path: string;
  serviceName: string | null;
  message: string;
};

const MEMORY_RE = /^\d+(\.\d+)?\s*([kmgKMG]?[bB]?)?$/;
const CPU_RE = /^\d+(\.\d+)?$/;
const DURATION_RE = /^\d+(\.\d+)?(ns|us|ms|s|m|h)$/;
const SERVICE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.]*$/;

function validPortNumber(value: string): boolean {
  if (!/^\d+$/.test(value)) return false;
  const n = Number(value);
  return n >= 1 && n <= 65535;
}

function validateService(svc: ServiceForm, form: ComposeForm, globalHostPorts: Map<string, string>): FormIssue[] {
  const issues: FormIssue[] = [];
  const name = svc.name.trim();
  const base = `services.${name || svc.id}`;

  if (!name) {
    issues.push({ severity: "error", path: `${base}.name`, serviceName: null, message: "Service name is required." });
  } else if (!SERVICE_NAME_RE.test(name)) {
    issues.push({
      severity: "error",
      path: `${base}.name`,
      serviceName: name,
      message: `Service name "${name}" is invalid — use letters, digits, dot, underscore or dash.`
    });
  }

  if (!svc.image.trim()) {
    issues.push({
      severity: "error",
      path: `${base}.image`,
      serviceName: name,
      message: "Image is required — a service cannot be deployed without one."
    });
  }

  // Ports.
  svc.ports.forEach((p, i) => {
    const path = `${base}.ports.${i}`;
    if (!p.target.trim()) {
      issues.push({ severity: "error", path, serviceName: name, message: "Container port is required." });
    } else if (!validPortNumber(p.target.trim())) {
      issues.push({
        severity: "error",
        path,
        serviceName: name,
        message: `Container port "${p.target}" is not a valid port (1–65535).`
      });
    }
    const published = p.published.trim();
    if (published) {
      // Support ranges like 8000-8010 minimally: validate both ends.
      const rangeParts = published.split("-");
      const allValid = rangeParts.every((part) => validPortNumber(part));
      if (!allValid) {
        issues.push({
          severity: "error",
          path,
          serviceName: name,
          message: `Published port "${published}" is not a valid port (1–65535).`
        });
      } else if (rangeParts.length === 1) {
        const key = `${p.hostIp.trim() || "0.0.0.0"}:${published}/${p.protocol}`;
        const owner = globalHostPorts.get(key);
        if (owner) {
          issues.push({
            severity: "error",
            path,
            serviceName: name,
            message: `Host port ${published}/${p.protocol} is already published by service "${owner}".`
          });
        } else {
          globalHostPorts.set(key, name);
        }
      }
    }
  });

  // Environment.
  const seenEnv = new Set<string>();
  svc.environment.forEach((e, i) => {
    const path = `${base}.environment.${i}`;
    const key = e.key.trim();
    if (!key) {
      issues.push({ severity: "error", path, serviceName: name, message: "Environment key cannot be empty." });
      return;
    }
    if (!ENV_KEY_RE.test(key)) {
      issues.push({
        severity: "error",
        path,
        serviceName: name,
        message: `Environment key "${key}" is invalid — must start with a letter or underscore.`
      });
    }
    if (seenEnv.has(key)) {
      issues.push({
        severity: "error",
        path,
        serviceName: name,
        message: `Duplicate environment key "${key}".`
      });
    }
    seenEnv.add(key);
  });

  // Volumes.
  svc.volumes.forEach((v, i) => {
    const path = `${base}.volumes.${i}`;
    const target = v.target.trim();
    if (!target) {
      issues.push({ severity: "error", path, serviceName: name, message: "Mount target path is required." });
    } else if (!target.startsWith("/")) {
      issues.push({
        severity: "error",
        path,
        serviceName: name,
        message: `Mount target "${target}" must be an absolute path inside the container.`
      });
    }
    if (v.kind === "bind" && v.source.trim() && !v.source.trim().startsWith("/")) {
      issues.push({
        severity: "error",
        path,
        serviceName: name,
        message: `Bind mount source "${v.source}" must be an absolute host path.`
      });
    }
    if (v.kind === "volume" && v.source.trim()) {
      const declared = form.volumes.some((tv) => tv.name.trim() === v.source.trim());
      if (!declared) {
        issues.push({
          severity: "warning",
          path,
          serviceName: name,
          message: `Named volume "${v.source}" is not declared under top-level volumes — Compose will create it implicitly.`
        });
      }
    }
  });

  // Networks.
  svc.networks.forEach((n, i) => {
    const path = `${base}.networks.${i}`;
    const netName = n.name.trim();
    if (!netName) {
      issues.push({ severity: "error", path, serviceName: name, message: "Network name cannot be empty." });
      return;
    }
    const declared = form.networks.some((tn) => tn.name.trim() === netName);
    if (!declared && netName !== "default") {
      issues.push({
        severity: "error",
        path,
        serviceName: name,
        message: `Network "${netName}" is not declared under top-level networks.`
      });
    }
  });

  // Resources.
  if (svc.resources.memoryLimit.trim() && !MEMORY_RE.test(svc.resources.memoryLimit.trim())) {
    issues.push({
      severity: "error",
      path: `${base}.resources.memoryLimit`,
      serviceName: name,
      message: `Memory limit "${svc.resources.memoryLimit}" is invalid — use e.g. 512m, 1g, 268435456.`
    });
  }
  if (svc.resources.memoryReservation.trim() && !MEMORY_RE.test(svc.resources.memoryReservation.trim())) {
    issues.push({
      severity: "error",
      path: `${base}.resources.memoryReservation`,
      serviceName: name,
      message: `Memory reservation "${svc.resources.memoryReservation}" is invalid — use e.g. 512m, 1g.`
    });
  }
  if (svc.resources.cpuLimit.trim() && !CPU_RE.test(svc.resources.cpuLimit.trim())) {
    issues.push({
      severity: "error",
      path: `${base}.resources.cpuLimit`,
      serviceName: name,
      message: `CPU limit "${svc.resources.cpuLimit}" is invalid — use a decimal number like 0.5 or 2.`
    });
  }
  if (svc.resources.cpuReservation.trim() && !CPU_RE.test(svc.resources.cpuReservation.trim())) {
    issues.push({
      severity: "error",
      path: `${base}.resources.cpuReservation`,
      serviceName: name,
      message: `CPU reservation "${svc.resources.cpuReservation}" is invalid — use a decimal number like 0.5 or 2.`
    });
  }

  // Healthcheck.
  if (svc.healthcheck.enabled) {
    if (svc.healthcheck.testKind !== "none" && !svc.healthcheck.test.trim()) {
      issues.push({
        severity: "error",
        path: `${base}.healthcheck.test`,
        serviceName: name,
        message: "Healthcheck command is required when a healthcheck is enabled."
      });
    }
    for (const [field, value] of [
      ["interval", svc.healthcheck.interval],
      ["timeout", svc.healthcheck.timeout],
      ["startPeriod", svc.healthcheck.startPeriod]
    ] as const) {
      if (value.trim() && !DURATION_RE.test(value.trim())) {
        issues.push({
          severity: "error",
          path: `${base}.healthcheck.${field}`,
          serviceName: name,
          message: `Healthcheck ${field} "${value}" is invalid — use a duration like 30s, 1m30s is not supported, use 90s.`
        });
      }
    }
    if (svc.healthcheck.retries.trim() && !/^\d+$/.test(svc.healthcheck.retries.trim())) {
      issues.push({
        severity: "error",
        path: `${base}.healthcheck.retries`,
        serviceName: name,
        message: `Healthcheck retries "${svc.healthcheck.retries}" must be a whole number.`
      });
    }
  }

  // Depends-on references.
  for (const dep of svc.dependsOn) {
    if (!form.services.some((s) => s.name.trim() === dep.trim())) {
      issues.push({
        severity: "error",
        path: `${base}.dependsOn`,
        serviceName: name,
        message: `depends_on references unknown service "${dep}".`
      });
    }
  }

  // Unsupported runtime options — informational, never blocking (round-tripped).
  const unsupportedKeys = Object.keys(svc.unsupported);
  if (unsupportedKeys.length > 0) {
    issues.push({
      severity: "warning",
      path: `${base}.unsupported`,
      serviceName: name,
      message: `${unsupportedKeys.length} runtime option(s) are not editable in the form and will be preserved unchanged: ${unsupportedKeys.join(", ")}.`
    });
  }

  return issues;
}

export function validateComposeForm(form: ComposeForm): FormIssue[] {
  const issues: FormIssue[] = [];

  if (form.parseError) {
    return [{ severity: "error", path: "root", serviceName: null, message: form.parseError }];
  }

  if (form.services.length === 0) {
    issues.push({
      severity: "error",
      path: "services",
      serviceName: null,
      message: "At least one service is required."
    });
  }

  const seenNames = new Set<string>();
  for (const svc of form.services) {
    const name = svc.name.trim();
    if (name && seenNames.has(name)) {
      issues.push({
        severity: "error",
        path: `services.${name}.name`,
        serviceName: name,
        message: `Duplicate service name "${name}".`
      });
    }
    seenNames.add(name);
  }

  const hostPorts = new Map<string, string>();
  for (const svc of form.services) {
    issues.push(...validateService(svc, form, hostPorts));
  }

  return issues;
}

export function hasBlockingIssues(issues: FormIssue[]): boolean {
  return issues.some((i) => i.severity === "error");
}
