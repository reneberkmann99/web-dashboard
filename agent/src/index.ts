import express, { Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { DockerAdapter } from "./docker/types";
import { MockDockerAdapter } from "./docker/mock-adapter";
import { RootlessDockerAdapter } from "./docker/rootless-adapter";

const app = express();
app.use(express.json());

const apiKey = process.env.AGENT_API_KEY;
const port = Number(process.env.AGENT_PORT ?? 8081);
const adapterMode = process.env.AGENT_DOCKER_MODE ?? "mock";
const adapter: DockerAdapter = adapterMode === "rootless" ? new RootlessDockerAdapter() : new MockDockerAdapter();

if (!apiKey) {
  throw new Error("AGENT_API_KEY is required");
}

app.use(
  rateLimit({
    windowMs: 10 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false
  })
);

app.use((req: Request, res: Response, next: NextFunction) => {
  const provided = req.header("x-agent-key");
  if (!provided || provided !== apiKey) {
    res.status(401).json({
      error: "UNAUTHORIZED"
    });
    return;
  }
  next();
});

const containerIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,127}$/);

app.get("/health", async (_req: Request, res: Response) => {
  const healthy = await adapter.health();
  res.json({
    nodeOnline: healthy,
    mode: adapterMode,
    rootlessHints: {
      dockerHost: process.env.DOCKER_HOST ? "configured" : "unset",
      xdgRuntimeDir: process.env.XDG_RUNTIME_DIR ? "configured" : "unset"
    }
  });
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
    res.status(400).json({
      nodeOnline: true,
      container: null,
      error: error instanceof Error ? error.message : "Invalid container id"
    });
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
    res.status(400).json({
      nodeOnline: true,
      logs: [],
      error: error instanceof Error ? error.message : "Failed to fetch logs"
    });
  }
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
    res.status(400).json({
      nodeOnline: true,
      success: false,
      error: error instanceof Error ? error.message : "Action failed"
    });
  }
});

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`[HostPanel Agent] listening on :${port} (mode=${adapterMode})`);
});
