import express, { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { DockerAdapter } from "./docker/types";
import { MockDockerAdapter } from "./docker/mock-adapter";
import { RootlessDockerAdapter } from "./docker/rootless-adapter";
import { DockerComposeAdapter } from "./docker/compose-adapter";
import {
  materializeRevision,
  readRevision,
  revisionDir,
  sanitizeId,
  setCurrent,
  writeJournal,
  readJournal,
  getCurrentRevisionNumber,
  resolveStateDir
} from "./deployments/state-dir";
import { verifyRequestSignature, withinTimestampWindow, NonceCache, sha256Hex } from "./security/signing";
import {
  generateKeyAndCsr,
  stageCertificate,
  promoteCandidate,
  discardCandidate,
  hasActiveTlsMaterial,
  readTlsMaterial,
  pkiDir
} from "./security/tls-material";
import https from "node:https";

export const AGENT_VERSION = "0.3.0";

const app = express();
app.use(
  express.json({
    // Capture the raw body so the signed-request verifier can hash the exact
    // bytes the control plane signed.
    verify: (req: Request, _res: Response, buf: Buffer) => {
      (req as unknown as { rawBody: Buffer }).rawBody = buf;
    }
  })
);

const port = Number(process.env.AGENT_PORT ?? 8081);
const adapterMode = process.env.AGENT_DOCKER_MODE ?? "mock";
const adapter: DockerAdapter =
  adapterMode === "rootless" ? new RootlessDockerAdapter() : new MockDockerAdapter();

// Read-only Compose adapter (Phase 6A): only `version` and `config`.
const composeAdapter = new DockerComposeAdapter();
let composeVersion: string | null = null;

async function detectCompose(): Promise<void> {
  composeVersion = await composeAdapter.version();
}

// ----- agent credentials ---------------------------------------------------
// Two paths:
//  1. AGENT_API_KEY set explicitly (manual enrollment, legacy) — used as-is.
//  2. AGENT_ENROLL_TOKEN set — the agent registers itself with the control
//     plane on startup, receives a fresh API key, and persists it to
//     AGENT_KEY_FILE so it survives restarts.
const MANUAL_KEY = process.env.AGENT_API_KEY;
const ENROLL_TOKEN = process.env.AGENT_ENROLL_TOKEN;
const CONTROL_PLANE_URL = process.env.CONTROL_PLANE_URL;
const KEY_FILE = process.env.AGENT_KEY_FILE;

let agentKey: string | null = MANUAL_KEY ?? null;

function loadKeyFile(): string | null {
  if (!KEY_FILE) return null;
  try {
    const value = fs.readFileSync(KEY_FILE, "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

function persistKeyFile(key: string): void {
  if (!KEY_FILE) return;
  try {
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
    fs.writeFileSync(KEY_FILE, key, { mode: 0o600 });
  } catch (error) {
    console.error(`[agent] failed to persist agent key to ${KEY_FILE}:`, error instanceof Error ? error.message : error);
  }
}

if (KEY_FILE) {
  const persisted = loadKeyFile();
  if (persisted) {
    agentKey = persisted;
  }
}

async function collectHostInfo() {
  let dockerVersion: string | null = null;
  try {
    dockerVersion = await adapter.version?.() ?? null;
  } catch {
    dockerVersion = null;
  }
  return {
    hostname: os.hostname(),
    os: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    cpuCount: os.cpus().length,
    totalMemBytes: os.totalmem(),
    agentVersion: AGENT_VERSION,
    dockerVersion
  };
}

/** One-time self-enrollment: register with the control plane and receive an API key. */
async function enroll(): Promise<boolean> {
  if (agentKey || !ENROLL_TOKEN || !CONTROL_PLANE_URL) {
    return Boolean(agentKey);
  }
  try {
    const info = await collectHostInfo();
    const response = await fetch(new URL("/api/agent/enroll", CONTROL_PLANE_URL).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: ENROLL_TOKEN,
        agentVersion: AGENT_VERSION,
        dockerVersion: info.dockerVersion,
        osInfo: { type: os.type(), release: os.release(), arch: os.arch() },
        systemInfo: {
          hostname: info.hostname,
          cpuCount: info.cpuCount,
          totalMemBytes: info.totalMemBytes
        },
        apiBaseUrl: `http://${info.hostname}:${port}`
      }),
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) {
      console.error(`[agent] enrollment rejected (HTTP ${response.status})`);
      return false;
    }
    const payload = (await response.json()) as { ok: boolean; data?: { apiKey: string; nodeId: string } };
    if (!payload.ok || !payload.data?.apiKey) {
      console.error("[agent] enrollment response missing apiKey");
      return false;
    }
    agentKey = payload.data.apiKey;
    persistKeyFile(payload.data.apiKey);
    console.log(`[agent] enrolled with control plane; node=${payload.data.nodeId}`);
    return true;
  } catch (error) {
    console.error("[agent] enrollment failed:", error instanceof Error ? error.message : error);
    return false;
  }
}

// ---------- rate limit + auth ----------
app.use(
  rateLimit({
    windowMs: 10 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false
  })
);

// Enroll endpoint must be reachable before the agent has a key; everything
// else requires the (now possibly persisted) agent key.
app.post("/enroll", async (req: Request, res: Response) => {
  // Delegate to the control plane. The control plane answers with the node
  // registration response; the agent proxies it back to whoever triggered
  // the enrollment command.
  res.status(501).json({ error: "use the control plane enrollment flow" });
});

app.use((req: Request, res: Response, next: NextFunction) => {
  if (!agentKey) {
    res.status(503).json({ error: "AGENT_NOT_ENROLLED" });
    return;
  }
  const provided = req.header("x-agent-key");
  if (!provided) {
    res.status(401).json({ error: "UNAUTHORIZED" });
    return;
  }
  const expected = Buffer.from(agentKey);
  const received = Buffer.from(provided);
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
    res.status(401).json({ error: "UNAUTHORIZED" });
    return;
  }
  next();
});

const nonceCache = new NonceCache();

/**
 * Signed-request verification for managed deployment MUTATION endpoints.
 * Requires the per-node key (existing auth) PLUS an HMAC signature over
 * method/path/timestamp/nonce/bodySha256/operationId, a fresh timestamp, a
 * unique nonce, and a body hash that matches the exact bytes received.
 */
function requireSignedRequest(req: Request, res: Response, next: NextFunction): void {
  if (!agentKey) {
    res.status(503).json({ error: "AGENT_NOT_ENROLLED" });
    return;
  }
  const signature = req.header("x-agent-signature");
  const timestampRaw = req.header("x-agent-timestamp");
  const nonce = req.header("x-agent-nonce");
  const operationId = req.header("x-agent-operation-id");
  if (!signature || !timestampRaw || !nonce || !operationId) {
    res.status(401).json({ error: "MISSING_SIGNATURE_HEADERS" });
    return;
  }
  const timestamp = Number(timestampRaw);
  if (!Number.isFinite(timestamp) || !withinTimestampWindow(timestamp)) {
    res.status(401).json({ error: "TIMESTAMP_OUT_OF_WINDOW" });
    return;
  }
  if (!nonceCache.checkAndRecord(nonce)) {
    res.status(401).json({ error: "NONCE_REPLAYED" });
    return;
  }
  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
  const bodySha256 = sha256Hex(rawBody ? rawBody.toString("utf8") : "");
  const valid = verifyRequestSignature(
    agentKey,
    { method: req.method, path: req.path, timestamp, nonce, bodySha256, operationId },
    signature
  );
  if (!valid) {
    res.status(401).json({ error: "INVALID_SIGNATURE" });
    return;
  }
  next();
}

function redact(text: string, secrets: Record<string, string>): string {
  let out = text;
  for (const value of Object.values(secrets)) {
    if (value && value.length > 2) {
      out = out.split(value).join("***");
    }
  }
  return out;
}

const containerIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,127}$/);

const composeValidateSchema = z.object({
  compose: z.string().min(1).max(1024 * 1024),
  env: z.record(z.string(), z.string().max(8192))
});

/**
 * Read-only Compose validation (Phase 6A). Runs `docker compose config` only.
 * The control plane sends non-secret values + deterministic secret sentinels;
 * no real secret value ever reaches this endpoint during validation.
 */
app.post("/compose/validate", async (req: Request, res: Response) => {
  try {
    const body = composeValidateSchema.parse(req.body);
    if (composeVersion === null) {
      res.json({
        nodeOnline: true,
        composeSupported: false,
        composeVersion: null,
        valid: false,
        errors: ["Docker Compose v2 is not available on this node."],
        normalized: null
      });
      return;
    }
    const result = await composeAdapter.config(body.compose, body.env);
    res.json({
      nodeOnline: true,
      composeSupported: true,
      composeVersion,
      valid: result.ok,
      errors: result.errors,
      normalized: result.normalized
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        nodeOnline: true,
        composeSupported: composeVersion !== null,
        composeVersion,
        valid: false,
        errors: ["Invalid compose validation request"],
        normalized: null
      });
    } else {
      res.status(502).json({
        nodeOnline: true,
        composeSupported: composeVersion !== null,
        composeVersion,
        valid: false,
        errors: ["Failed to validate compose"],
        normalized: null
      });
    }
  }
});

app.get("/health", async (_req: Request, res: Response) => {
  const healthy = await adapter.health();
  const info = await collectHostInfo();
  res.json({
    nodeOnline: healthy,
    mode: adapterMode,
    agentVersion: AGENT_VERSION,
    hostname: info.hostname,
    os: info.os,
    arch: info.arch,
    cpuCount: info.cpuCount,
    totalMemBytes: info.totalMemBytes,
    dockerVersion: info.dockerVersion,
    composeSupported: composeVersion !== null,
    composeVersion,
    managedDeploymentValidationSupported: composeVersion !== null,
    rootlessHints: {
      dockerHost: process.env.DOCKER_HOST ? "configured" : "unset",
      xdgRuntimeDir: process.env.XDG_RUNTIME_DIR ? "configured" : "unset"
    }
  });
});

app.get("/info", async (_req: Request, res: Response) => {
  const info = await collectHostInfo();
  res.json({
    ...info,
    nodeOnline: await adapter.health(),
    composeSupported: composeVersion !== null,
    composeVersion,
    managedDeploymentValidationSupported: composeVersion !== null
  });
});

app.get("/storage", async (_req: Request, res: Response) => {
  try {
    const summary = adapter.getStorageSummary
      ? await adapter.getStorageSummary()
      : [];
    res.json({ nodeOnline: true, summary });
  } catch (error) {
    res.status(503).json({ nodeOnline: false, summary: [], error: "Unable to fetch storage summary" });
  }
});

const resourceNameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/);
const MAX_BATCH_NAMES = 50;

/**
 * Batch network inspection. Names are supplied as a JSON body array (POST,
 * not GET) because a workload can reference more networks than comfortably
 * fits a query string, and the request carries no side effects — it's a
 * read, but shaped like one for payload-size reasons.
 */
app.post("/networks/inspect", async (req: Request, res: Response) => {
  try {
    const names = z.array(resourceNameSchema).max(MAX_BATCH_NAMES).parse(req.body?.names ?? []);
    const networks = adapter.inspectNetworks ? await adapter.inspectNetworks(names) : [];
    res.json({ nodeOnline: true, networks });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ nodeOnline: true, networks: [], error: "Invalid network name(s)" });
    } else {
      res.status(502).json({ nodeOnline: true, networks: [], error: "Failed to inspect networks" });
    }
  }
});

app.post("/volumes/inspect", async (req: Request, res: Response) => {
  try {
    const names = z.array(resourceNameSchema).max(MAX_BATCH_NAMES).parse(req.body?.names ?? []);
    const volumes = adapter.inspectVolumes ? await adapter.inspectVolumes(names) : [];
    res.json({ nodeOnline: true, volumes });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ nodeOnline: true, volumes: [], error: "Invalid volume name(s)" });
    } else {
      res.status(502).json({ nodeOnline: true, volumes: [], error: "Failed to inspect volumes" });
    }
  }
});

const prepareSchema = z.object({
  operationId: z.string().min(1).max(200),
  revisionNumber: z.number().int().positive(),
  compose: z.string().min(1).max(1024 * 1024),
  env: z.record(z.string(), z.string().max(8192)),
  composeProjectName: z.string().min(1).max(255)
});
const revisionOpSchema = z.object({
  operationId: z.string().min(1).max(200),
  revisionNumber: z.number().int().positive()
});
const applySchema = z.object({
  operationId: z.string().min(1).max(200),
  revisionNumber: z.number().int().positive(),
  secrets: z.record(z.string(), z.string().max(8192))
});
const abortSchema = z.object({ operationId: z.string().min(1).max(200) });

app.post("/deployments/:deploymentId/prepare", requireSignedRequest, async (req: Request, res: Response) => {
  try {
    const deploymentId = sanitizeId(req.params.deploymentId as string);
    const body = prepareSchema.parse(req.body);
    materializeRevision(deploymentId, body.revisionNumber, body.compose, body.env, body.composeProjectName);
    writeJournal(deploymentId, {
      operationId: body.operationId, deploymentId, action: "PREPARE", state: "PREPARED", startedAt: new Date().toISOString()
    });
    res.json({ ok: true, prepared: true, revisionNumber: body.revisionNumber });
  } catch (error) {
    res.status(400).json({ ok: false, prepared: false, revisionNumber: 0, error: "prepare failed" });
  }
});

app.post("/deployments/:deploymentId/pull", requireSignedRequest, async (req: Request, res: Response) => {
  try {
    const deploymentId = sanitizeId(req.params.deploymentId as string);
    const body = revisionOpSchema.parse(req.body);
    const revision = readRevision(deploymentId, body.revisionNumber);
    if (!revision) {
      res.status(404).json({ ok: false, images: [], error: "revision not prepared" });
      return;
    }
    const { code, stderr } = await composeAdapter.pull(revisionDir(deploymentId, body.revisionNumber), revision.env, revision.projectName, body.operationId);
    if (code !== 0) {
      res.json({ ok: false, images: [], error: redact(stderr, {}) || "pull failed" });
      return;
    }
    res.json({ ok: true, images: [] });
  } catch (error) {
    res.status(502).json({ ok: false, images: [], error: "pull failed" });
  }
});

/**
 * Replace deterministic secret sentinels (`__HOSTPANEL_SECRET_<KEY>__`) with
 * `${<KEY>}` references so `docker compose` interpolates the REAL secret value
 * from the restricted child environment at `up -d` time. The real value is
 * never written to disk; compose resolves it from env and stores it only in the
 * container's own Config.Env.
 */
function substituteSecretRefs(compose: string, secrets: Record<string, string>): string {
  let out = compose;
  for (const key of Object.keys(secrets)) {
    out = out.split(`__HOSTPANEL_SECRET_${key}__`).join(`\${${key}}`);
  }
  return out;
}

app.post("/deployments/:deploymentId/apply", requireSignedRequest, async (req: Request, res: Response) => {
  try {
    const deploymentId = sanitizeId(req.params.deploymentId as string);
    const body = applySchema.parse(req.body);
    const revision = readRevision(deploymentId, body.revisionNumber);
    if (!revision) {
      res.status(404).json({ ok: false, applied: false, error: "revision not prepared" });
      return;
    }
    const env = { ...revision.env, ...body.secrets };
    // Materialize a runtime compose with sentinels swapped for ${KEY} refs, in a
    // throwaway temp dir (0600) so no real secret is persisted in the state dir.
    const runtimeCompose = substituteSecretRefs(revision.compose, body.secrets);
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "hostpanel-apply-"));
    let code = 1;
    let stderr = "";
    try {
      fs.writeFileSync(path.join(runtimeDir, "compose.yml"), runtimeCompose, { mode: 0o600 });
      const result = await composeAdapter.upDetached(runtimeDir, env, revision.projectName, body.operationId);
      code = result.code;
      stderr = result.stderr;
    } finally {
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
    if (code !== 0) {
      res.json({ ok: false, applied: false, error: redact(stderr, body.secrets) || "apply failed" });
      return;
    }
    writeJournal(deploymentId, {
      operationId: body.operationId, deploymentId, action: "APPLY", state: "APPLIED", startedAt: new Date().toISOString()
    });
    res.json({ ok: true, applied: true });
  } catch (error) {
    res.status(502).json({ ok: false, applied: false, error: "apply failed" });
  }
});

app.post("/deployments/:deploymentId/verify", requireSignedRequest, async (req: Request, res: Response) => {
  try {
    const deploymentId = sanitizeId(req.params.deploymentId as string);
    const body = revisionOpSchema.parse(req.body);
    const revision = readRevision(deploymentId, body.revisionNumber);
    if (!revision) {
      res.json({ verdict: "DRIFTED", services: [] });
      return;
    }
    const dir = revisionDir(deploymentId, body.revisionNumber);
    const servicesResult = await composeAdapter.configServices(dir, revision.env, revision.projectName);
    const expected = servicesResult.stdout.trim().split("\n").map((s) => s.trim()).filter(Boolean);
    const psResult = await composeAdapter.psJson(dir, revision.env, revision.projectName);

    let running = 0;
    let unhealthy = 0;
    const services: {
      name: string;
      status: string;
      health: string | null;
      restartCount: number;
      imageId: string | null;
      repoDigest: string | null;
      imageRef: string | null;
    }[] = [];
    const containerIds: string[] = [];
    try {
      // `docker compose ps --format json` emits JSON Lines (one object per
      // line), not a JSON array.
      const lines = psResult.stdout.trim().split("\n").filter(Boolean);
      const rows = lines.map((l) => JSON.parse(l)) as Array<{ Service?: string; State?: string; Health?: string; ID?: string }>;
      for (const row of rows) {
        const name = row.Service ?? "";
        const status = row.State ?? "unknown";
        const health = row.Health ?? null;
        if (row.ID) containerIds.push(row.ID);
        services.push({ name, status, health, restartCount: 0, imageId: null, repoDigest: null, imageRef: null });
        if (status === "running") {
          running += 1;
          if (health === "unhealthy") unhealthy += 1;
        }
      }
    } catch {
      // unparseable ps output -> drifted
    }

    // ACTUAL runtime image identity (batched: one inspect + one image inspect).
    try {
      const inspected = await composeAdapter.inspectContainerImages(containerIds, revision.env);
      const byIndex = new Map(inspected.map((i, idx) => [idx, i]));
      const imageIds = inspected.map((i) => i.imageId).filter((v): v is string => Boolean(v));
      const digests = await composeAdapter.inspectImageDigests(imageIds, revision.env);
      for (let i = 0; i < services.length; i++) {
        const info = byIndex.get(i);
        if (!info) continue;
        services[i].imageId = info.imageId;
        services[i].imageRef = info.imageRef;
        services[i].repoDigest = info.imageId ? digests.get(info.imageId) ?? null : null;
      }
    } catch {
      // image identity is best-effort; verdict is unaffected
    }

    const present = new Set(services.map((s) => s.name));
    const missing = expected.filter((e) => !present.has(e));
    let verdict: "CONVERGED_HEALTHY" | "CONVERGED_DEGRADED" | "DRIFTED" | "FAILED";
    if (missing.length > 0 || running < expected.length) {
      verdict = "DRIFTED";
    } else if (unhealthy > 0) {
      verdict = "CONVERGED_DEGRADED";
    } else {
      verdict = "CONVERGED_HEALTHY";
    }
    res.json({ verdict, services });
  } catch (error) {
    res.json({ verdict: "FAILED", services: [] });
  }
});

app.post("/deployments/:deploymentId/abort", requireSignedRequest, async (req: Request, res: Response) => {
  try {
    const deploymentId = sanitizeId(req.params.deploymentId as string);
    const body = abortSchema.parse(req.body);
    DockerComposeAdapter.abort(body.operationId);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ ok: false });
  }
});

app.get("/deployments/:deploymentId/state", async (req: Request, res: Response) => {
  try {
    const deploymentId = sanitizeId(req.params.deploymentId as string);
    res.json({ exists: true, currentRevisionNumber: getCurrentRevisionNumber(deploymentId) });
  } catch (error) {
    res.status(400).json({ exists: false, currentRevisionNumber: null });
  }
});

app.get("/containers", async (_req: Request, res: Response) => {
  try {
    const containers = await adapter.listContainers();
    res.json({
      nodeOnline: true,
      containers
    });
  } catch (error) {
    res.status(503).json({
      nodeOnline: false,
      containers: [],
      error: error instanceof Error ? error.message : "Unable to list containers"
    });
  }
});

app.get("/containers/:id", async (req: Request, res: Response) => {
  try {
    const containerId = containerIdSchema.parse(req.params.id);
    const container = await adapter.getContainer(containerId);
    res.json({
      nodeOnline: true,
      container
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ nodeOnline: true, container: null, error: "Invalid container id" });
    } else {
      res.status(502).json({ nodeOnline: true, container: null, error: "Failed to inspect container" });
    }
  }
});

app.get("/containers/:id/logs", async (req: Request, res: Response) => {
  try {
    const containerId = containerIdSchema.parse(req.params.id);
    const tail = Math.max(1, Math.min(Number(req.query.tail ?? 200), 500));
    const logs = await adapter.getContainerLogs(containerId, Number.isNaN(tail) ? 200 : tail);
    res.json({
      nodeOnline: true,
      logs
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ nodeOnline: true, logs: [], error: "Invalid container id" });
    } else {
      res.status(502).json({ nodeOnline: true, logs: [], error: "Failed to fetch logs" });
    }
  }
});

/**
 * Streaming logs (tail + follow). Emits raw newline-delimited lines; the
 * control plane wraps these into Server-Sent Events for the browser. The
 * underlying docker process is torn down as soon as the consumer disconnects.
 */
app.get("/containers/:id/logs/stream", (req: Request, res: Response) => {
  let containerId: string;
  try {
    containerId = containerIdSchema.parse(req.params.id);
  } catch {
    res.status(400).json({ error: "Invalid container id" });
    return;
  }
  const tail = Math.max(1, Math.min(Number(req.query.tail ?? 200), 500));

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  let stream: { stdout: NodeJS.ReadableStream; kill: () => void };
  try {
    stream = adapter.streamContainerLogs(containerId, Number.isNaN(tail) ? 200 : tail);
  } catch (error) {
    res.status(502).json({ error: "Failed to stream logs" });
    return;
  }

  const { stdout, kill } = stream;
  const cleanup = (): void => {
    try {
      kill();
    } catch {
      // ignore
    }
  };

  stdout.on("data", (chunk: Buffer | string) => {
    if (!res.writableEnded) res.write(chunk);
  });
  stdout.on("end", () => {
    if (!res.writableEnded) res.end();
  });
  stdout.on("error", () => {
    if (!res.writableEnded) res.end();
  });
  req.on("close", cleanup);
  res.on("close", cleanup);
});

app.post("/containers/:id/:action", async (req: Request, res: Response) => {
  const actionSchema = z.enum(["start", "stop", "restart"]);

  try {
    const containerId = containerIdSchema.parse(req.params.id);
    const action = actionSchema.parse(req.params.action);

    const success = await adapter.runAction(containerId, action);
    res.json({
      nodeOnline: true,
      success
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ nodeOnline: true, success: false, error: "Invalid container id or action" });
    } else {
      res.status(502).json({ nodeOnline: true, success: false, error: "Action failed" });
    }
  }
});

/**
 * TLS certificate enrollment (Phase 6B.1). The agent generates its key + CSR
 * LOCALLY and sends only the CSR, authenticated by a short-lived one-time
 * enrollment token. The control plane assigns the identity and returns the
 * signed certificate + CA chain.
 */
async function enrollTls(token: string): Promise<boolean> {
  if (!CONTROL_PLANE_URL) {
    console.error("[agent] TLS enrollment requires CONTROL_PLANE_URL");
    return false;
  }
  try {
    const { csrPem } = generateKeyAndCsr();
    const response = await fetch(new URL("/api/agent/tls-enroll", CONTROL_PLANE_URL).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, csrPem, tlsPort: tlsPort }),
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) {
      discardCandidate();
      console.error(`[agent] TLS enrollment rejected (HTTP ${response.status})`);
      return false;
    }
    const payload = (await response.json()) as {
      ok: boolean;
      data?: { certPem: string; caPem: string; identity: string; notAfter: string };
    };
    if (!payload.ok || !payload.data?.certPem || !payload.data?.caPem) {
      discardCandidate();
      console.error("[agent] TLS enrollment response missing certificate");
      return false;
    }
    stageCertificate(payload.data.certPem, payload.data.caPem);
    if (!promoteCandidate()) {
      discardCandidate();
      console.error("[agent] failed to promote TLS candidate");
      return false;
    }
    startHttpsListener();
    console.log(`[agent] TLS certificate installed (identity=${payload.data.identity}, expires=${payload.data.notAfter})`);
    return true;
  } catch (error) {
    discardCandidate();
    console.error("[agent] TLS enrollment failed:", error instanceof Error ? error.message : error);
    return false;
  }
}

const tlsPort = Number(process.env.AGENT_TLS_PORT ?? port + 1000);
let httpsServer: https.Server | null = null;

/** Start (or restart) the HTTPS listener with the current TLS material. */
function startHttpsListener(): void {
  const material = readTlsMaterial();
  if (!material) {
    console.log("[agent] no TLS material — HTTPS listener not started");
    return;
  }
  if (httpsServer) {
    httpsServer.close();
    httpsServer = null;
  }
  try {
    httpsServer = https.createServer({ key: material.key, cert: material.cert }, app);
    httpsServer.listen(tlsPort, () => {
      console.log(`[HostPanel Agent] HTTPS listening on :${tlsPort}`);
    });
    httpsServer.on("error", (err) => {
      console.error("[agent] HTTPS listener error:", err.message);
    });
  } catch (error) {
    console.error("[agent] failed to start HTTPS listener:", error instanceof Error ? error.message : error);
  }
}

/**
 * Local-only TLS enrollment trigger. Requires the agent key (same auth as
 * every other agent route) and a control-plane-issued one-time token; the
 * agent never receives a private key from the control plane.
 */
app.post("/tls/enroll", async (req: Request, res: Response) => {
  try {
    const body = z.object({ token: z.string().min(16).max(512) }).parse(req.body);
    const ok = await enrollTls(body.token);
    res.json({ ok, tlsPort });
  } catch {
    res.status(400).json({ ok: false, error: "invalid tls enrollment request" });
  }
});

app.listen(port, async () => {
  console.log(`[HostPanel Agent] listening on :${port} (mode=${adapterMode}, version=${AGENT_VERSION})`);
  console.log(`[HostPanel Agent] state dir: ${resolveStateDir()} (pki: ${pkiDir()})`);
  if (adapterMode === "rootless") {
    console.log(`[HostPanel Agent] DOCKER_HOST=${process.env.DOCKER_HOST ?? "(unset)"}`);
    console.log(`[HostPanel Agent] XDG_RUNTIME_DIR=${process.env.XDG_RUNTIME_DIR ?? "(unset)"}`);
  }
  if (hasActiveTlsMaterial()) {
    startHttpsListener();
  } else {
    console.log("[HostPanel Agent] no agent certificate yet — enroll secure transport to enable managed deployment");
  }
  void detectCompose().then(() => {
    if (composeVersion) {
      console.log(`[HostPanel Agent] docker compose ${composeVersion} available (read-only validation)`);
    } else {
      console.log("[HostPanel Agent] docker compose plugin not available — managed definition validation will report composeSupported=false");
    }
  });
  if (ENROLL_TOKEN && CONTROL_PLANE_URL && !agentKey) {
    console.log("[HostPanel Agent] enrollment token present — registering with control plane…");
    const ok = await enroll();
    if (!ok) {
      console.error("[HostPanel Agent] enrollment failed; will retry on restart");
    }
  } else if (!agentKey) {
    console.error("[HostPanel Agent] no API key configured (set AGENT_API_KEY or AGENT_ENROLL_TOKEN + CONTROL_PLANE_URL)");
  }
});
