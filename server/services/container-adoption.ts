import { prisma } from "@/server/db";
import { logAuditEvent } from "@/server/audit";
import { nodeAgentClient } from "@/server/services/node-agent/client";
import { createDeployment } from "@/server/services/deployments";
import { analyzeComposeDefinition, type SecurityFinding } from "@/server/services/deployment-security";
import { parse as parseYaml } from "yaml";
import { stringify as stringifyYaml } from "yaml";
import type { AuthSession } from "@/server/auth/session";
import type {
  containerInspectSchema
} from "@/server/services/node-agent/types";
import type { z } from "zod";

/**
 * Manual standalone-container adoption (Section 3).
 *
 * Brings a `docker run`-style container under Noderaft management WITHOUT
 * recreating it:
 *
 *   1. preflight — full `docker inspect` via the node agent, per-field
 *      PASS / WARNING / BLOCKER verdict, and a synthesized compose definition
 *      that matches the running container.
 *   2. adopt — the synthesized definition goes through the EXISTING
 *      createDeployment engine (validation + canonicalization on the node),
 *      the inventory row is associated, and the live container is labeled as
 *      belonging to the new compose project (labels only — never a restart).
 *      runtimeState is set to CONVERGED because the runtime already matches
 *      the adopted definition. Only later edits/deploys may recreate it.
 *
 * A BLOCKER refuses adoption outright. Warnings (bind mounts, plaintext env,
 * privileged, host networking) are shown but do not block; high-risk findings
 * still require explicit acknowledgement, exactly like any other revision.
 *
 * Never runs `docker rm`; never stops or restarts the container; named
 * volumes and external networks are declared `external: true` so Compose can
 * never delete them.
 */

export type AdoptionVerdict = "PASS" | "WARNING" | "BLOCKER";

export type AdoptionField = {
  field: string;
  verdict: AdoptionVerdict;
  detail: string;
};

export type ContainerAdoptionPreview = {
  nodeId: string;
  dockerContainerId: string;
  dockerName: string;
  status: string;
  startedAt: string | null;
  fields: AdoptionField[];
  warnings: AdoptionField[];
  blockers: AdoptionField[];
  /** Synthesized compose definition (service matches the live container). */
  compose: string;
  /** High-risk findings the composed definition triggers (need ack to adopt). */
  highRiskFindings: SecurityFinding[];
  alreadyManaged: boolean;
  existingWorkloadId: string | null;
  existingWorkloadName: string | null;
  nodeOnline: boolean;
};

export type AdoptContainerResult =
  | { status: "adopted"; projectId: string; deploymentId: string; revisionId: string; revisionNumber: number; labelsApplied: boolean }
  | { status: "already_managed"; workloadId: string; workloadName: string }
  | { status: "blocked"; blockers: AdoptionField[] }
  | { status: "node_offline" }
  | { status: "invalid"; findings: SecurityFinding[]; composeErrors: string[] }
  | { status: "ack_required"; highRiskFindings: SecurityFinding[] }
  | { status: "compose_unavailable" };

type Inspect = z.infer<typeof containerInspectSchema>;

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "adopted"
  );
}

/** Convert a docker duration in nanoseconds to a compose duration string. */
function nsToDuration(ns: number | undefined): string {
  if (ns === undefined || ns <= 0) return "";
  const s = Math.round(ns / 1_000_000_000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m${rem}s`;
}

function toComposeDevices(devices: unknown[] | null | undefined): string[] {
  if (!devices) return [];
  return devices
    .map((d) => {
      if (typeof d !== "object" || d === null) return "";
      const rec = d as Record<string, unknown>;
      const host = String(rec.PathOnHost ?? "");
      const container = String(rec.PathInContainer ?? "");
      const perms = String(rec.CgroupPermissions ?? "");
      if (!container) return "";
      return perms ? `${host}:${container}:${perms}` : `${host}:${container}`;
    })
    .filter(Boolean);
}

function toComposeUlimits(ulimits: unknown[] | null | undefined): unknown {
  if (!ulimits) return undefined;
  const out: Record<string, unknown> = {};
  for (const u of ulimits) {
    if (typeof u !== "object" || u === null) continue;
    const rec = u as Record<string, unknown>;
    const name = String(rec.Name ?? "");
    if (!name) continue;
    out[name] = { soft: rec.Soft ?? 0, hard: rec.Hard ?? 0 };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Synthesize a compose definition that reproduces the inspected container.
 * Everything without a structured compose equivalent lands in the
 * "unsupported" bucket, which the form model round-trips verbatim.
 */
export function synthesizeComposeFromInspect(
  inspect: Inspect,
  containerName: string,
  composeProjectName: string
): { compose: string; fields: AdoptionField[]; highRiskFindings: SecurityFinding[] } {
  const fields: AdoptionField[] = [];
  const config = inspect.Config ?? {};
  const hostConfig = inspect.HostConfig ?? {};
  const name = containerName.replace(/^\//, "");

  const svc: Record<string, unknown> = {};

  // --- image ---------------------------------------------------------------
  const image = config.Image;
  if (!image) {
    fields.push({ field: "image", verdict: "BLOCKER", detail: "Container has no image — cannot be reproduced." });
  } else {
    svc.image = image;
    const pinHint = /^[a-zA-Z0-9._-]+:[a-zA-Z0-9._-]+$/.test(image) || image.includes("@sha256:");
    fields.push({
      field: "image",
      verdict: "PASS",
      detail: `Reproduced as "${image}".${pinHint ? "" : " Unpinned image reference — consider pinning a tag or digest."}`
    });
  }

  // Pin the container name so the first compose-managed deploy reconciles the
  // SAME container instead of creating a differently-named twin.
  svc.container_name = name;

  // --- command / entrypoint -------------------------------------------------
  if (config.Cmd && config.Cmd.length > 0) {
    svc.command = config.Cmd;
    fields.push({ field: "command", verdict: "PASS", detail: config.Cmd.join(" ") });
  }
  if (config.Entrypoint && config.Entrypoint.length > 0) {
    svc.entrypoint = config.Entrypoint;
    fields.push({ field: "entrypoint", verdict: "PASS", detail: config.Entrypoint.join(" ") });
  }

  // --- identity -------------------------------------------------------------
  if (config.Hostname && config.Hostname !== inspect.Id?.slice(0, 12)) {
    svc.hostname = config.Hostname;
    fields.push({ field: "hostname", verdict: "PASS", detail: config.Hostname });
  }
  if (config.WorkingDir) {
    svc.working_dir = config.WorkingDir;
    fields.push({ field: "working_dir", verdict: "PASS", detail: config.WorkingDir });
  }
  if (config.User) {
    svc.user = config.User;
    fields.push({ field: "user", verdict: "PASS", detail: config.User });
  }

  // --- environment ----------------------------------------------------------
  const envEntries = config.Env ?? [];
  if (envEntries.length > 0) {
    svc.environment = envEntries;
    fields.push({
      field: "environment",
      verdict: "WARNING",
      detail: `${envEntries.length} variable(s) stored in the managed definition. Convert sensitive values to Noderaft secrets after adoption.`
    });
  }

  // --- runtime policy -------------------------------------------------------
  const restartName = hostConfig.RestartPolicy?.Name;
  if (restartName && restartName !== "" && restartName !== "no") {
    svc.restart = restartName;
    fields.push({ field: "restart", verdict: "PASS", detail: restartName });
  }
  if (hostConfig.Privileged) {
    svc.privileged = true;
    fields.push({ field: "privileged", verdict: "WARNING", detail: "Privileged container — high-risk, requires acknowledgement." });
  }
  if (hostConfig.ReadonlyRootfs) {
    svc.read_only = true;
    fields.push({ field: "read_only", verdict: "PASS", detail: "Read-only root filesystem." });
  }
  const capAdd = hostConfig.CapAdd ?? [];
  const capDrop = hostConfig.CapDrop ?? [];
  if (capAdd.length > 0) {
    svc.cap_add = capAdd;
    fields.push({ field: "cap_add", verdict: "WARNING", detail: `${capAdd.join(", ")} — extra capabilities are high-risk.` });
  }
  if (capDrop.length > 0) {
    svc.cap_drop = capDrop;
    fields.push({ field: "cap_drop", verdict: "PASS", detail: capDrop.join(", ") });
  }

  // --- ports ----------------------------------------------------------------
  const portBindings = hostConfig.PortBindings ?? {};
  const ports: string[] = [];
  for (const [containerPortProto, bindings] of Object.entries(portBindings)) {
    for (const b of bindings ?? []) {
      const hostIp = b.HostIp && b.HostIp !== "" ? b.HostIp : "";
      const hostPort = b.HostPort ?? "";
      ports.push(hostIp ? `${hostIp}:${hostPort}:${containerPortProto}` : `${hostPort}:${containerPortProto}`);
    }
  }
  if (ports.length > 0) {
    svc.ports = ports;
    fields.push({ field: "ports", verdict: "PASS", detail: ports.join(", ") });
  }

  // Exposed-but-unpublished ports are preserved in the unsupported bucket.
  const exposed = config.ExposedPorts ?? {};
  const exposedKeys = Object.keys(exposed).filter((k) => !(k in (portBindings ?? {})));
  if (exposedKeys.length > 0) {
    (svc as Record<string, unknown>).expose = exposedKeys;
  }

  // --- volumes / mounts -----------------------------------------------------
  const mounts = inspect.Mounts ?? [];
  const volumes: string[] = [];
  const tmpfsTargets: string[] = [];
  let bindCount = 0;
  for (const m of mounts) {
    const target = m.Destination;
    if (!target) continue;
    const ro = m.RW === false ? ":ro" : "";
    if (m.Type === "volume" && m.Name) {
      volumes.push(`${m.Name}:${target}${ro}`);
    } else if (m.Type === "bind" && m.Source) {
      volumes.push(`${m.Source}:${target}${ro}`);
      bindCount += 1;
    } else if (m.Type === "tmpfs") {
      tmpfsTargets.push(target);
    }
  }
  if (volumes.length > 0) {
    svc.volumes = volumes;
    fields.push({
      field: "volumes",
      verdict: bindCount > 0 ? "WARNING" : "PASS",
      detail:
        volumes.join(", ") +
        (bindCount > 0
          ? ` — ${bindCount} bind mount(s) reference host paths on THIS node; they will not exist on other nodes.`
          : "")
    });
  }
  if (tmpfsTargets.length > 0) {
    (svc as Record<string, unknown>).tmpfs = tmpfsTargets;
  }
  const hostTmpfs = hostConfig.Tmpfs ?? {};
  const hostTmpfsTargets = Object.keys(hostTmpfs);
  if (hostTmpfsTargets.length > 0) {
    (svc as Record<string, unknown>).tmpfs = [...tmpfsTargets, ...hostTmpfsTargets];
  }

  // --- networks -------------------------------------------------------------
  const networkMode = hostConfig.NetworkMode ?? "";
  const networks: Record<string, unknown> = {};
  const topNetworks: Record<string, unknown> = {};
  if (networkMode === "host") {
    (svc as Record<string, unknown>).network_mode = "host";
    fields.push({ field: "networks", verdict: "WARNING", detail: "Host networking — container shares the node's network namespace." });
  } else if (networkMode.startsWith("container:")) {
    // Handled as a BLOCKER in the preflight; here just reflect it.
    (svc as Record<string, unknown>).network_mode = networkMode;
  } else if (networkMode === "none") {
    (svc as Record<string, unknown>).network_mode = "none";
  } else {
    const attached = inspect.NetworkSettings?.Networks ?? {};
    const netNames = Object.keys(attached);
    if (netNames.length === 0) {
      fields.push({ field: "networks", verdict: "PASS", detail: "No explicit networks (compose default network)." });
    } else {
      for (const netName of netNames) {
        const netInfo = attached[netName];
        topNetworks[netName] = { external: true };
        const cfg: Record<string, unknown> = {};
        const aliases = (netInfo?.Aliases ?? []).filter((a) => a !== name && a !== netName);
        if (aliases.length > 0) cfg.aliases = aliases;
        networks[netName] = Object.keys(cfg).length > 0 ? cfg : null;
      }
      svc.networks = networks;
      fields.push({
        field: "networks",
        verdict: "PASS",
        detail: `${netNames.join(", ")} — declared external so Noderaft never creates or removes them.`
      });
    }
  }

  // --- healthcheck ----------------------------------------------------------
  const hc = config.Healthcheck;
  if (hc && hc.Test && hc.Test.length > 0) {
    const hcOut: Record<string, unknown> = { test: hc.Test };
    if (hc.Test[0] === "NONE") hcOut.disable = true;
    const interval = nsToDuration(hc.Interval);
    if (interval) hcOut.interval = interval;
    const timeout = nsToDuration(hc.Timeout);
    if (timeout) hcOut.timeout = timeout;
    if (hc.Retries !== undefined) hcOut.retries = hc.Retries;
    const startPeriod = nsToDuration(hc.StartPeriod);
    if (startPeriod) hcOut.start_period = startPeriod;
    svc.healthcheck = hcOut;
    fields.push({ field: "healthcheck", verdict: "PASS", detail: (hc.Test ?? []).join(" ") });
  }

  // --- resources ------------------------------------------------------------
  const deploy: Record<string, unknown> = {};
  const limits: Record<string, unknown> = {};
  const mem = hostConfig.Memory;
  if (mem && mem > 0) {
    limits.memory = mem;
    fields.push({ field: "memory_limit", verdict: "PASS", detail: `${Math.round(mem / 1024 / 1024)} MB` });
  }
  const nanoCpus = hostConfig.NanoCpus;
  if (nanoCpus && nanoCpus > 0) {
    limits.cpus = String(nanoCpus / 1_000_000_000);
    fields.push({ field: "cpu_limit", verdict: "PASS", detail: `${nanoCpus / 1_000_000_000} cores` });
  }
  if (Object.keys(limits).length > 0) {
    deploy.resources = { limits };
    svc.deploy = deploy;
  }

  // --- labels ---------------------------------------------------------------
  const labels = config.Labels ?? {};
  const customLabels = Object.fromEntries(
    Object.entries(labels).filter(([k]) => !k.startsWith("com.docker.compose.") && !k.startsWith("com.noderaft."))
  );
  if (Object.keys(customLabels).length > 0) {
    svc.labels = customLabels;
    fields.push({ field: "labels", verdict: "PASS", detail: `${Object.keys(customLabels).length} label(s)` });
  }

  // --- unsupported runtime options (round-tripped verbatim) -----------------
  const unsupported: Record<string, unknown> = {};
  const devices = toComposeDevices(hostConfig.Devices);
  if (devices.length > 0) {
    unsupported.devices = devices;
    fields.push({ field: "devices", verdict: "WARNING", detail: `${devices.length} device(s) — preserved but high-risk.` });
  }
  if (hostConfig.Dns && hostConfig.Dns.length > 0) {
    unsupported.dns = hostConfig.Dns;
    fields.push({ field: "dns", verdict: "PASS", detail: hostConfig.Dns.join(", ") });
  }
  if (hostConfig.DnsSearch && hostConfig.DnsSearch.length > 0) unsupported.dns_search = hostConfig.DnsSearch;
  const ulimits = toComposeUlimits(hostConfig.Ulimits);
  if (ulimits !== undefined) unsupported.ulimits = ulimits;
  if (hostConfig.Sysctls && Object.keys(hostConfig.Sysctls).length > 0) unsupported.sysctls = hostConfig.Sysctls;
  if (hostConfig.SecurityOpt && hostConfig.SecurityOpt.length > 0) {
    unsupported.security_opt = hostConfig.SecurityOpt;
    fields.push({ field: "security_opt", verdict: "WARNING", detail: "Security options preserved verbatim." });
  }
  if (networkMode === "host" || networkMode === "none" || networkMode.startsWith("container:")) {
    unsupported.network_mode = networkMode;
  }
  if (hostConfig.PidMode && hostConfig.PidMode !== "") unsupported.pid = hostConfig.PidMode;
  if (hostConfig.IpcMode && hostConfig.IpcMode !== "" && hostConfig.IpcMode !== "private") {
    unsupported.ipc = hostConfig.IpcMode;
    fields.push({ field: "ipc", verdict: "WARNING", detail: hostConfig.IpcMode });
  }
  if (hostConfig.ShmSize && hostConfig.ShmSize > 0) unsupported.shm_size = hostConfig.ShmSize;
  if (hostConfig.LogConfig?.Type && hostConfig.LogConfig.Type !== "json-file") {
    unsupported.logging = { driver: hostConfig.LogConfig.Type, options: hostConfig.LogConfig.Config ?? {} };
  }

  if (Object.keys(unsupported).length > 0) {
    fields.push({
      field: "unsupported_options",
      verdict: "PASS",
      detail: `${Object.keys(unsupported).join(", ")} — preserved in the definition and editable via Compose source.`
    });
  }
  for (const [k, v] of Object.entries(unsupported)) svc[k] = v;

  // --- assemble -------------------------------------------------------------
  const root: Record<string, unknown> = {
    services: { [slugify(name)]: svc }
  };
  if (Object.keys(topNetworks).length > 0) root.networks = topNetworks;

  const namedVolumes = mounts
    .filter((m) => m.Type === "volume" && m.Name)
    .map((m) => m.Name as string);
  if (namedVolumes.length > 0) {
    root.volumes = Object.fromEntries(namedVolumes.map((v) => [v, { external: true }]));
    fields.push({
      field: "named_volumes",
      verdict: "PASS",
      detail: `${namedVolumes.join(", ")} — declared external: true; Noderaft can never delete them.`
    });
  }

  const compose = stringifyYaml(root, { lineWidth: 0 });

  const analyzed = analyzeComposeDefinition({
    composeSource: compose,
    secretReferences: [],
    policy: "ADMIN"
  });

  return { compose, fields, highRiskFindings: analyzed.findings.filter((f) => f.severity === "HIGH_RISK") };
}

export async function previewContainerAdoption(
  nodeId: string,
  dockerContainerId: string
): Promise<ContainerAdoptionPreview | null> {
  const node = await prisma.node.findUnique({ where: { id: nodeId } });
  if (!node) return null;

  const { nodeOnline, inspect } = await nodeAgentClient.inspectContainerFull(node, dockerContainerId);
  if (!nodeOnline) {
    return {
      nodeId,
      dockerContainerId,
      dockerName: dockerContainerId,
      status: "unknown",
      startedAt: null,
      fields: [{ field: "inspect", verdict: "BLOCKER", detail: "Node is offline — cannot inspect the container." }],
      warnings: [],
      blockers: [{ field: "inspect", verdict: "BLOCKER", detail: "Node is offline." }],
      compose: "",
      highRiskFindings: [],
      alreadyManaged: false,
      existingWorkloadId: null,
      existingWorkloadName: null,
      nodeOnline: false
    };
  }
  if (!inspect) {
    return {
      nodeId,
      dockerContainerId,
      dockerName: dockerContainerId,
      status: "unknown",
      startedAt: null,
      fields: [{ field: "inspect", verdict: "BLOCKER", detail: "Container not found on the node." }],
      warnings: [],
      blockers: [{ field: "inspect", verdict: "BLOCKER", detail: "Container not found." }],
      compose: "",
      highRiskFindings: [],
      alreadyManaged: false,
      existingWorkloadId: null,
      existingWorkloadName: null,
      nodeOnline: true
    };
  }

  const dockerName = (inspect.Name ?? dockerContainerId).replace(/^\//, "");

  // Already managed by another workload?
  const row = await prisma.container.findUnique({
    where: { nodeId_dockerContainerId: { nodeId, dockerContainerId } },
    include: { project: { select: { id: true, name: true } } }
  });
  const alreadyManaged = Boolean(row?.projectId && row?.project);

  // BLOCKER: joins another container's network namespace — not reproducible
  // as a compose definition.
  const fields: AdoptionField[] = [];
  if ((inspect.HostConfig?.NetworkMode ?? "").startsWith("container:")) {
    fields.push({
      field: "network_mode",
      verdict: "BLOCKER",
      detail: `Network mode "${inspect.HostConfig?.NetworkMode}" shares another container's namespace — cannot be reproduced safely.`
    });
  }

  // Compose project name for the future workload (must not collide).
  const composeProjectName = `${slugify(dockerName)}-${dockerContainerId.slice(0, 6)}`;

  const { compose, fields: synthFields, highRiskFindings } = synthesizeComposeFromInspect(
    inspect,
    dockerName,
    composeProjectName
  );
  fields.push(...synthFields);

  const blockers = fields.filter((f) => f.verdict === "BLOCKER");
  const warnings = fields.filter((f) => f.verdict === "WARNING");

  return {
    nodeId,
    dockerContainerId,
    dockerName,
    status: inspect.State?.Status ?? inspect.State?.Running === true ? "running" : "unknown",
    startedAt: inspect.State?.StartedAt ?? null,
    fields,
    warnings,
    blockers,
    compose,
    highRiskFindings,
    alreadyManaged,
    existingWorkloadId: alreadyManaged ? (row?.project?.id ?? null) : null,
    existingWorkloadName: alreadyManaged ? (row?.project?.name ?? null) : null,
    nodeOnline: true
  };
}

export async function adoptContainer(input: {
  nodeId: string;
  dockerContainerId: string;
  name?: string;
  slug?: string;
  description?: string | null;
  clientAccountId?: string | null;
  acknowledgedFindings: string[];
  actor: AuthSession;
  sourceIp?: string | null;
}): Promise<AdoptContainerResult> {
  const preview = await previewContainerAdoption(input.nodeId, input.dockerContainerId);
  if (!preview) return { status: "blocked", blockers: [{ field: "node", verdict: "BLOCKER", detail: "Node not found." }] };
  if (!preview.nodeOnline) return { status: "node_offline" };
  if (preview.alreadyManaged && preview.existingWorkloadId) {
    return {
      status: "already_managed",
      workloadId: preview.existingWorkloadId,
      workloadName: preview.existingWorkloadName ?? "unknown"
    };
  }
  if (preview.blockers.length > 0) return { status: "blocked", blockers: preview.blockers };

  const missingAcks = preview.highRiskFindings.filter((f) => !input.acknowledgedFindings.includes(f.fingerprint ?? ""));
  if (missingAcks.length > 0) {
    return { status: "ack_required", highRiskFindings: missingAcks };
  }

  const friendlyName = input.name?.trim() || preview.dockerName;
  const composeProjectName = `${slugify(preview.dockerName)}-${input.dockerContainerId.slice(0, 6)}`;

  const created = await createDeployment({
    nodeId: input.nodeId,
    name: friendlyName,
    slug: input.slug?.trim() || slugify(friendlyName),
    description: input.description ?? null,
    clientAccountId: input.clientAccountId ?? null,
    composeProjectName,
    compose: preview.compose,
    environment: {},
    secretReferences: [],
    acknowledgedFindings: input.acknowledgedFindings,
    deployNote: `Adopted container ${preview.dockerName} without recreation`,
    policy: "ADMIN",
    actor: input.actor,
    sourceIp: input.sourceIp ?? null
  });

  if (created.status === "compose_unavailable") return { status: "compose_unavailable" };
  if (created.status === "invalid") {
    return { status: "invalid", findings: created.findings, composeErrors: created.composeErrors };
  }
  if (created.status === "ack_required") {
    return { status: "ack_required", highRiskFindings: created.highRiskFindings };
  }
  if (created.status !== "created") {
    return { status: "blocked", blockers: [{ field: "adopt", verdict: "BLOCKER", detail: created.status }] };
  }

  // Associate the inventory row with the new workload.
  const serviceName = Object.keys((parseYaml(preview.compose) as { services: Record<string, unknown> }).services)[0];
  await prisma.container.update({
    where: { nodeId_dockerContainerId: { nodeId: input.nodeId, dockerContainerId: input.dockerContainerId } },
    data: {
      projectId: created.projectId,
      composeProject: composeProjectName,
      composeService: serviceName,
      isActive: true
    }
  });

  // The runtime already matches the adopted definition — mark CONVERGED.
  await prisma.deployment.update({
    where: { id: created.deploymentId },
    data: { runtimeState: "CONVERGED" }
  });

  // Label the LIVE container (labels only — no restart, no recreation) so the
  // first compose-managed deploy can reconcile it in place. Failure is
  // non-fatal: the definition is correct either way; a deploy will surface
  // any conflict explicitly.
  let labelsApplied = false;
  try {
    const node = await prisma.node.findUnique({ where: { id: input.nodeId } });
    if (node) {
      labelsApplied = await nodeAgentClient.labelContainer(node, input.dockerContainerId, {
        "com.docker.compose.project": composeProjectName,
        "com.docker.compose.service": serviceName,
        "com.docker.compose.version": "adopted",
        "com.noderaft.adopted": "true"
      });
    }
  } catch {
    labelsApplied = false;
  }

  await logAuditEvent({
    actorUserId: input.actor.userId,
    actorEmail: input.actor.email,
    actorRole: input.actor.role,
    clientAccountId: input.clientAccountId ?? null,
    action: "WORKLOAD_ADOPTED",
    targetType: "PROJECT",
    targetId: created.projectId,
    metadata: {
      deploymentId: created.deploymentId,
      dockerContainerId: input.dockerContainerId,
      dockerName: preview.dockerName,
      composeProjectName,
      labelsApplied,
      recreated: false
    },
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null
  });

  return {
    status: "adopted",
    projectId: created.projectId,
    deploymentId: created.deploymentId,
    revisionId: created.revisionId,
    revisionNumber: created.revisionNumber,
    labelsApplied
  };
}
