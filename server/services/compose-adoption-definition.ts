import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { prisma } from "@/server/db";
import { nodeAgentClient } from "@/server/services/node-agent/client";
import { synthesizeComposeFromInspect } from "@/server/services/container-adoption";
import { createDeployment } from "@/server/services/deployments";
import { analyzeComposeDefinition, type SecurityFinding } from "@/server/services/deployment-security";
import type { AuthSession } from "@/server/auth/session";

/**
 * Compose adoption definition synthesis.
 *
 * adoptComposeProject() links a discovered Compose project's containers to a
 * Noderaft Project, but by itself produces no Deployment/Revision — so an
 * adopted stack had no managed definition for the structured form editor to
 * open. This module closes that gap: it inspects the project's live
 * containers through the agent (read-only), reproduces each one as a compose
 * service (reusing the standalone-adoption synthesizer), merges the services
 * into a single compose document, and authors a normal Deployment + Revision
 * #1 through the EXISTING createDeployment engine.
 *
 * No container is ever created, removed or restarted here: adoption is labels/
 * DB state only. Named volumes and external networks are declared
 * external:true, so Noderaft can never delete them. If the agent is offline
 * or inspection fails, the workload is still adopted (containers linked) —
 * the definition simply isn't created yet, and the caller reports why.
 */

export type MergeEntry = { serviceName: string; compose: string };

export type MergeResult = {
  compose: string;
  serviceNames: string[];
  networks: string[];
  volumes: string[];
};

/**
 * Merge per-service synthesized compose documents into one project document.
 * Pure function — unit-tested without any agent/docker involvement.
 *
 * Each synthesized document has exactly one service; the service key is
 * replaced by the container's real compose service name. Top-level networks
 * and volumes are merged with name-based dedupe (all external:true by
 * construction of the synthesizer).
 */
export function mergeSynthesizedServices(entries: MergeEntry[]): MergeResult {
  const services: Record<string, unknown> = {};
  const networks: Record<string, unknown> = {};
  const volumes: Record<string, unknown> = {};
  const serviceNames: string[] = [];

  for (const entry of entries) {
    const key = entry.serviceName.trim();
    if (!key || services[key]) continue;
    let doc: Record<string, unknown>;
    try {
      doc = parseYaml(entry.compose) as Record<string, unknown>;
    } catch {
      continue;
    }
    const svcEntries = Object.entries((doc.services ?? {}) as Record<string, unknown>);
    if (svcEntries.length === 0) continue;
    services[key] = svcEntries[0][1];
    serviceNames.push(key);
    for (const [name, def] of Object.entries((doc.networks ?? {}) as Record<string, unknown>)) {
      if (!(name in networks)) networks[name] = def;
    }
    for (const [name, def] of Object.entries((doc.volumes ?? {}) as Record<string, unknown>)) {
      if (!(name in volumes)) volumes[name] = def;
    }
  }

  const root: Record<string, unknown> = { services };
  if (Object.keys(networks).length > 0) root.networks = networks;
  if (Object.keys(volumes).length > 0) root.volumes = volumes;

  return {
    compose: stringifyYaml(root, { lineWidth: 0 }),
    serviceNames,
    networks: Object.keys(networks),
    volumes: Object.keys(volumes)
  };
}

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

export type ComposeAdoptionDefinitionResult =
  | { status: "definition_created"; deploymentId: string; projectId: string; revisionId: string; serviceNames: string[] }
  | { status: "node_offline" }
  | { status: "no_containers" }
  | { status: "synthesis_failed"; detail: string }
  | { status: "compose_unavailable" }
  | { status: "invalid"; composeErrors: string[]; findings: SecurityFinding[] }
  | { status: "ack_required"; highRiskFindings: SecurityFinding[] };

export async function createComposeAdoptionDefinition(input: {
  nodeId: string;
  projectId: string;
  composeProject: string;
  name: string;
  clientAccountId?: string | null;
  acknowledgedFindings: string[];
  actor: AuthSession;
  sourceIp?: string | null;
}): Promise<ComposeAdoptionDefinitionResult> {
  const node = await prisma.node.findUnique({ where: { id: input.nodeId } });
  if (!node) return { status: "node_offline" };

  const containers = await prisma.container.findMany({
    where: { nodeId: input.nodeId, projectId: input.projectId, isActive: true },
    select: { dockerContainerId: true, dockerName: true, composeService: true }
  });
  if (containers.length === 0) return { status: "no_containers" };

  const entries: MergeEntry[] = [];
  for (const c of containers) {
    let res: { nodeOnline: boolean; inspect: unknown };
    try {
      res = await nodeAgentClient.inspectContainerFull(node, c.dockerContainerId);
    } catch {
      res = { nodeOnline: false, inspect: null };
    }
    if (!res.nodeOnline || !res.inspect) {
      return { status: "synthesis_failed", detail: `Agent could not inspect container ${c.dockerName}` };
    }
    const synth = synthesizeComposeFromInspect(res.inspect as never, c.dockerName, input.composeProject);
    entries.push({ serviceName: c.composeService || slugify(c.dockerName), compose: synth.compose });
  }

  const merged = mergeSynthesizedServices(entries);
  if (merged.serviceNames.length === 0) {
    return { status: "synthesis_failed", detail: "No services could be synthesized from the project containers" };
  }

  // The acknowledgement contract must match what createDeployment will
  // re-validate: analyze the FINAL merged document (with the real compose
  // service names), not the per-container synthesis fragments — fingerprints
  // derive from the service name, so they must be computed on the same
  // document the deployment revision will actually carry.
  const analyzed = analyzeComposeDefinition({
    composeSource: merged.compose,
    secretReferences: [],
    policy: "ADMIN"
  });
  const missingAcks = analyzed.findings.filter(
    (f) => f.severity === "HIGH_RISK" && !input.acknowledgedFindings.includes(f.fingerprint)
  );
  if (missingAcks.length > 0) {
    return { status: "ack_required", highRiskFindings: missingAcks };
  }

  const created = await createDeployment({
    nodeId: input.nodeId,
    name: input.name,
    slug: slugify(input.name),
    description: null,
    clientAccountId: input.clientAccountId ?? null,
    composeProjectName: input.composeProject,
    compose: merged.compose,
    environment: {},
    secretReferences: [],
    acknowledgedFindings: input.acknowledgedFindings,
    deployNote: `Adopted compose project ${input.composeProject} without recreation`,
    policy: "ADMIN",
    adoptExistingProjectId: input.projectId,
    actor: input.actor,
    sourceIp: input.sourceIp ?? null
  });

  switch (created.status) {
    case "compose_unavailable":
      return { status: "compose_unavailable" };
    case "invalid":
      return { status: "invalid", composeErrors: created.composeErrors, findings: created.findings };
    case "ack_required":
      return { status: "ack_required", highRiskFindings: created.highRiskFindings };
    case "node_not_found":
      return { status: "node_offline" };
    case "created":
      break;
    default:
      return { status: "synthesis_failed", detail: created.status };
  }

  // The runtime already matches the adopted definition — mark CONVERGED.
  await prisma.deployment.update({
    where: { id: created.deploymentId },
    data: { runtimeState: "CONVERGED" }
  });

  return {
    status: "definition_created",
    deploymentId: created.deploymentId,
    projectId: created.projectId,
    revisionId: created.revisionId,
    serviceNames: merged.serviceNames
  };
}
