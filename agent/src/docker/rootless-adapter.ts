import { spawn } from "node:child_process";
import { DockerAdapter, RuntimeContainer } from "./types";

type DockerRow = {
  ID: string;
  Names: string;
  Image: string;
  State: string;
  Status: string;
  Ports: string;
};

type DockerStatsRow = {
  ID: string;
  CPUPerc: string;
  MemUsage: string;
};

function sanitizeContainerId(containerId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,127}$/.test(containerId)) {
    throw new Error("Invalid container id");
  }
  return containerId;
}

function parseStatus(value: string): RuntimeContainer["status"] {
  const normalized = value.toLowerCase();
  if (normalized.includes("unhealthy")) {
    return "unhealthy";
  }
  if (normalized.includes("restart")) {
    return "restarting";
  }
  if (normalized.includes("running")) {
    return "running";
  }
  if (normalized.includes("stop") || normalized.includes("exit")) {
    return "stopped";
  }
  return "unknown";
}

function parseCpuPercent(raw: string | undefined): number | null {
  if (!raw) {
    return null;
  }

  const parsed = Number(raw.replace("%", "").trim());
  return Number.isNaN(parsed) ? null : parsed;
}

export class RootlessDockerAdapter implements DockerAdapter {
  private env(): NodeJS.ProcessEnv {
    // Security: adapter only forwards explicit docker rootless env vars.
    return {
      ...process.env,
      ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
      ...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {})
    };
  }

  private runDocker(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn("docker", args, {
        env: this.env(),
        stdio: ["ignore", "pipe", "pipe"]
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(stderr || `docker command failed with code ${code}`));
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }

  async health(): Promise<boolean> {
    try {
      await this.runDocker(["info", "--format", "{{json .ServerVersion}}"]);
      return true;
    } catch {
      return false;
    }
  }

  async listContainers(): Promise<RuntimeContainer[]> {
    const [{ stdout: psOutput }, { stdout: statsOutput }] = await Promise.all([
      this.runDocker(["ps", "-a", "--format", "{{json .}}"]),
      this.runDocker(["stats", "--no-stream", "--format", "{{json .}}"])
    ]);

    const rows = psOutput
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as DockerRow);

    const statsRows = new Map<string, DockerStatsRow>(
      statsOutput
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const parsed = JSON.parse(line) as DockerStatsRow;
          return [parsed.ID, parsed];
        })
    );

    const results: RuntimeContainer[] = [];

    for (const row of rows) {
      const inspect = await this.runDocker(["inspect", row.ID, "--format", "{{json .}}"]);
      const detail = JSON.parse(inspect.stdout.trim()) as {
        Created?: string;
        RestartCount?: number;
      };

      const stat = statsRows.get(row.ID);

      results.push({
        id: row.ID,
        name: row.Names,
        image: row.Image,
        status: parseStatus(row.Status || row.State),
        uptime: row.Status,
        ports: row.Ports || "-",
        createdAt: detail.Created ?? null,
        cpuPercent: parseCpuPercent(stat?.CPUPerc),
        memoryUsage: stat?.MemUsage ?? null,
        restartCount: detail.RestartCount ?? null,
        lastUpdatedAt: new Date().toISOString()
      });
    }

    return results;
  }

  async getContainer(containerId: string): Promise<RuntimeContainer | null> {
    const safeId = sanitizeContainerId(containerId);
    const containers = await this.listContainers();
    return containers.find((container) => container.id === safeId || container.name === safeId) ?? null;
  }

  async getContainerLogs(containerId: string, tail: number): Promise<string[]> {
    const safeId = sanitizeContainerId(containerId);
    const { stdout, stderr } = await this.runDocker(["logs", "--tail", String(tail), safeId]);
    const merged = `${stdout}${stderr}`.trim();
    return merged ? merged.split("\n") : ["No logs"]; 
  }

  async runAction(containerId: string, action: "start" | "stop" | "restart"): Promise<boolean> {
    const safeId = sanitizeContainerId(containerId);
    await this.runDocker([action, safeId]);
    return true;
  }
}
