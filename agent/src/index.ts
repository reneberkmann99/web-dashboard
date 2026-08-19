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

export const AGENT_VERSION = "0.2.0";

const app = express();
app.use(express.json());

const port = Number(process.env.AGENT_PORT ?? 8081);
const adapterMode = process.env.AGENT_DOCKER_MODE ?? "mock";
const adapter: DockerAdapter =
  adapterMode === "rootless" ? new RootlessDockerAdapter() : new MockDockerAdapter();

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

const containerIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,127}$/);

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
    rootlessHints: {
      dockerHost: process.env.DOCKER_HOST ? "configured" : "unset",
      xdgRuntimeDir: process.env.XDG_RUNTIME_DIR ? "configured" : "unset"
    }
  });
});

app.get("/info", async (_req: Request, res: Response) => {
  const info = await collectHostInfo();
  res.json({ ...info, nodeOnline: await adapter.health() });
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

app.listen(port, async () => {
  console.log(`[HostPanel Agent] listening on :${port} (mode=${adapterMode}, version=${AGENT_VERSION})`);
  if (adapterMode === "rootless") {
    console.log(`[HostPanel Agent] DOCKER_HOST=${process.env.DOCKER_HOST ?? "(unset)"}`);
    console.log(`[HostPanel Agent] XDG_RUNTIME_DIR=${process.env.XDG_RUNTIME_DIR ?? "(unset)"}`);
  }
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
