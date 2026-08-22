import { spawn } from "node:child_process";
import { DockerAdapter, RuntimeContainer, StorageSummaryEntry, NetworkInfo, VolumeInfo } from "./types";

/**
 * Security: Rootless Docker adapter.
 * - All container IDs are validated with sanitizeContainerId() BEFORE being passed to spawn().
 * - Arguments are passed as an array to spawn() — never through a shell.
 * - Only DOCKER_HOST and XDG_RUNTIME_DIR env vars are forwarded to the child process.
 * - No user-supplied strings are interpolated into shell commands.
 */

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

/**
 * Security: strict validation for container identifiers before passing to Docker CLI.
 * Allows only alphanumeric characters, underscores, dots, and hyphens.
 * Must start with an alphanumeric character and be 2-128 chars.
 */
function sanitizeContainerId(containerId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,127}$/.test(containerId)) {
    throw new Error("Invalid container id: must be 2-128 alphanumeric/dash/dot/underscore characters");
  }
  return containerId;
}

/**
 * Security: strict validation for Docker network/volume names before passing
 * to the CLI. Same character class as container ids (Docker resource names
 * share this constraint); rejects anything else rather than guessing.
 */
function sanitizeResourceName(name: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name)) {
    throw new Error("Invalid docker resource name");
  }
  return name;
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
    // Security: only forward explicit Docker rootless env vars.
    // All other env vars are inherited from the agent process.
    const env = { ...process.env };
    if (process.env.DOCKER_HOST) {
      env.DOCKER_HOST = process.env.DOCKER_HOST;
    }
    if (process.env.XDG_RUNTIME_DIR) {
      env.XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR;
    }
    return env;
  }

  private runDocker(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      // Security: arguments are passed as an array — no shell interpolation.
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

      child.on("error", (err) => {
        // Improve diagnosis: ENOENT means docker binary not found
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new Error("Docker binary not found. Ensure Docker is installed and in PATH."));
        } else {
          reject(err);
        }
      });
      child.on("close", (code) => {
        if (code !== 0) {
          const msg = stderr.trim() || `docker ${args[0]} failed with exit code ${code}`;
          reject(new Error(msg));
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
    } catch (error) {
      console.error("[RootlessAdapter] health check failed:", error instanceof Error ? error.message : error);
      return false;
    }
  }

  async version(): Promise<string | null> {
    try {
      const { stdout } = await this.runDocker(["info", "--format", "{{.ServerVersion}}"]);
      const value = stdout.trim();
      return value || null;
    } catch {
      return null;
    }
  }

  /**
   * Full `docker inspect` document — required by manual container adoption
   * (the control plane synthesizes a compose definition from the live
   * container). Returns the raw daemon document (first element of the
   * inspect array) or null when the container does not exist.
   */
  async inspectContainerFull(containerId: string): Promise<unknown> {
    const { stdout } = await this.runDocker(["inspect", containerId]);
    const parsed = JSON.parse(stdout.trim()) as unknown[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed[0] : null;
  }

  private async inspectDetails(containerId: string): Promise<NonNullable<RuntimeContainer["details"]>> {
    try {
      const { stdout } = await this.runDocker([
        "inspect",
        containerId,
        "--format",
        "{{json .}}"
      ]);
      const raw = JSON.parse(stdout.trim()) as {
        HostConfig?: { RestartPolicy?: { Name?: string } };
        Config?: { Labels?: Record<string, string> };
        NetworkSettings?: { Networks?: Record<string, { IPAddress?: string; Gateway?: string }> };
        Mounts?: Array<{ Type?: string; Source?: string; Destination?: string; Mode?: string }>;
        State?: { Status?: string; Health?: { Status?: string } };
        Image?: string;
      };
      return {
        restartPolicy: raw.HostConfig?.RestartPolicy?.Name ?? null,
        labels: raw.Config?.Labels ?? {},
        networks: Object.entries(raw.NetworkSettings?.Networks ?? {}).map(([name, n]) => ({
          name,
          ipAddress: n.IPAddress ?? "",
          gateway: n.Gateway ?? ""
        })),
        mounts: (raw.Mounts ?? []).map((m) => ({
          type: m.Type ?? "unknown",
          source: m.Source ?? "",
          destination: m.Destination ?? "",
          mode: m.Mode ?? ""
        })),
        imageId: raw.Image ?? null,
        state: raw.State?.Status ?? null,
        health: raw.State?.Health?.Status ?? null
      };
    } catch {
      return { restartPolicy: null, labels: {}, networks: [], mounts: [] };
    }
  }

  private listCache: { at: number; value: RuntimeContainer[] } | null = null;
  private listCacheTtlMs = 15000;

  async listContainers(): Promise<RuntimeContainer[]> {
    const now = Date.now();
    if (this.listCache && now - this.listCache.at < this.listCacheTtlMs) {
      return this.listCache.value;
    }
    const value = await this.listContainersUncached();
    this.listCache = { at: now, value };
    return value;
  }

  private async listContainersUncached(): Promise<RuntimeContainer[]> {
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
      // Security: validate even Docker-returned IDs before passing to further commands
      const safeId = sanitizeContainerId(row.ID);
      const inspect = await this.runDocker(["inspect", safeId, "--format", "{{json .}}"]);
      const detail = JSON.parse(inspect.stdout.trim()) as {
        Created?: string;
        RestartCount?: number;
        Config?: { Labels?: Record<string, string> };
        NetworkSettings?: { Networks?: Record<string, unknown> };
        Mounts?: Array<{ Type?: string; Source?: string; Destination?: string; Mode?: string; Name?: string }>;
        HostConfig?: { RestartPolicy?: { Name?: string } };
        State?: { Health?: { Status?: string } };
      };

      const stat = statsRows.get(row.ID);
      const labels = detail.Config?.Labels ?? {};

      results.push({
        id: row.ID,
        name: row.Names,
        image: row.Image,
        // Runtime and health are separate concepts: a container can be
        // RUNNING while its Docker healthcheck is UNHEALTHY.
        status: parseStatus(row.State),
        health:
          detail.State?.Health?.Status === "healthy" ||
          detail.State?.Health?.Status === "unhealthy" ||
          detail.State?.Health?.Status === "starting"
            ? detail.State.Health.Status
            : null,
        uptime: row.Status,
        ports: row.Ports || "-",
        createdAt: detail.Created ?? null,
        cpuPercent: parseCpuPercent(stat?.CPUPerc),
        memoryUsage: stat?.MemUsage ?? null,
        restartCount: detail.RestartCount ?? null,
        restartPolicy: detail.HostConfig?.RestartPolicy?.Name ?? null,
        composeProject: labels["com.docker.compose.project"] ?? null,
        composeService: labels["com.docker.compose.service"] ?? null,
        networkNames: Object.keys(detail.NetworkSettings?.Networks ?? {}),
        mountRefs: (detail.Mounts ?? []).map((m) => ({
          type: m.Type ?? "unknown",
          source: m.Source ?? "",
          destination: m.Destination ?? "",
          mode: m.Mode ?? "",
          volumeName: m.Type === "volume" ? (m.Name ?? null) : null
        })),
        lastUpdatedAt: new Date().toISOString()
      });
    }

    return results;
  }

  async getContainer(containerId: string): Promise<RuntimeContainer | null> {
    const safeId = sanitizeContainerId(containerId);
    const containers = await this.listContainers();
    const container = containers.find((container) => container.id === safeId || container.name === safeId);
    if (!container) return null;
    container.details = await this.inspectDetails(safeId);
    return container;
  }

  async getContainerLogs(containerId: string, tail: number): Promise<string[]> {
    const safeId = sanitizeContainerId(containerId);
    const safeTail = Math.max(1, Math.min(tail, 500));
    const { stdout, stderr } = await this.runDocker(["logs", "--tail", String(safeTail), safeId]);
    const merged = `${stdout}${stderr}`.trim();
    return merged ? merged.split("\n") : ["No logs"]; 
  }

  async getStorageSummary(): Promise<StorageSummaryEntry[]> {
    try {
      const { stdout } = await this.runDocker(["system", "df", "--format", "{{json .}}"]);
      return stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const parsed = JSON.parse(line) as {
            Type?: string;
            TotalCount?: string;
            Active?: string;
            Size?: string;
            Reclaimable?: string;
          };
          return {
            type: parsed.Type ?? "unknown",
            totalCount: Number(parsed.TotalCount ?? 0),
            active: Number(parsed.Active ?? 0),
            size: parsed.Size ?? "0B",
            reclaimable: parsed.Reclaimable ?? "0B"
          };
        });
    } catch (error) {
      console.error("[RootlessAdapter] storage summary failed:", error instanceof Error ? error.message : error);
      return [];
    }
  }

  async inspectNetworks(names: string[]): Promise<NetworkInfo[]> {
    const safeNames = Array.from(new Set(names.map(sanitizeResourceName))).slice(0, 100);
    if (safeNames.length === 0) return [];
    try {
      const { stdout } = await this.runDocker(["network", "inspect", ...safeNames]);
      const raw = JSON.parse(stdout.trim()) as Array<{
        Name: string;
        Id: string;
        Driver: string;
        Scope: string;
        Internal: boolean;
        IPAM?: { Config?: Array<{ Subnet?: string; Gateway?: string }> };
        Containers?: Record<string, { Name?: string }>;
      }>;
      return raw.map((n) => ({
        name: n.Name,
        id: n.Id,
        driver: n.Driver,
        scope: n.Scope,
        internal: Boolean(n.Internal),
        subnets: (n.IPAM?.Config ?? []).map((c) => c.Subnet).filter((s): s is string => Boolean(s)),
        gateways: (n.IPAM?.Config ?? []).map((c) => c.Gateway).filter((s): s is string => Boolean(s)),
        attachedContainers: Object.values(n.Containers ?? {})
          .map((c) => c.Name)
          .filter((s): s is string => Boolean(s))
      }));
    } catch (error) {
      console.error("[RootlessAdapter] network inspect failed:", error instanceof Error ? error.message : error);
      // Individual missing/removed networks shouldn't fail the whole batch;
      // fall back to per-name inspection so one bad name doesn't blank the tab.
      const results: NetworkInfo[] = [];
      for (const name of safeNames) {
        try {
          const { stdout } = await this.runDocker(["network", "inspect", name]);
          const [n] = JSON.parse(stdout.trim()) as Array<{
            Name: string;
            Id: string;
            Driver: string;
            Scope: string;
            Internal: boolean;
            IPAM?: { Config?: Array<{ Subnet?: string; Gateway?: string }> };
            Containers?: Record<string, { Name?: string }>;
          }>;
          if (n) {
            results.push({
              name: n.Name,
              id: n.Id,
              driver: n.Driver,
              scope: n.Scope,
              internal: Boolean(n.Internal),
              subnets: (n.IPAM?.Config ?? []).map((c) => c.Subnet).filter((s): s is string => Boolean(s)),
              gateways: (n.IPAM?.Config ?? []).map((c) => c.Gateway).filter((s): s is string => Boolean(s)),
              attachedContainers: Object.values(n.Containers ?? {})
                .map((c) => c.Name)
                .filter((s): s is string => Boolean(s))
            });
          }
        } catch {
          // skip missing/removed network
        }
      }
      return results;
    }
  }

  async inspectVolumes(names: string[]): Promise<VolumeInfo[]> {
    const safeNames = Array.from(new Set(names.map(sanitizeResourceName))).slice(0, 100);
    if (safeNames.length === 0) return [];
    const results: VolumeInfo[] = [];
    for (const name of safeNames) {
      try {
        const { stdout } = await this.runDocker(["volume", "inspect", name]);
        const [v] = JSON.parse(stdout.trim()) as Array<{ Name: string; Driver: string; Mountpoint?: string }>;
        if (v) {
          results.push({ name: v.Name, driver: v.Driver, mountpoint: v.Mountpoint ?? null });
        }
      } catch {
        // volume no longer exists — skip rather than fail the batch
      }
    }
    return results;
  }

  streamContainerLogs(containerId: string, tail: number): {
    stdout: NodeJS.ReadableStream;
    kill: () => void;
  } {
    const safeId = sanitizeContainerId(containerId);
    const safeTail = Math.max(1, Math.min(tail, 500));
    // Security: arguments passed as an array — no shell interpolation. The
    // `--timestamps` flag keeps each line prefixed with an RFC3339 timestamp.
    const child = spawn(
      "docker",
      ["logs", "--tail", String(safeTail), "--follow", "--timestamps", safeId],
      { env: this.env(), stdio: ["ignore", "pipe", "pipe"] }
    );

    // Merge stderr into stdout so we stream a single ordered-ish stream.
    if (child.stderr) {
      child.stderr.on("data", (chunk) => child.stdout.emit("data", chunk));
    }

    return {
      stdout: child.stdout,
      kill: () => {
        child.kill("SIGTERM");
      }
    };
  }

  async runAction(containerId: string, action: "start" | "stop" | "restart"): Promise<boolean> {
    const safeId = sanitizeContainerId(containerId);
    await this.runDocker([action, safeId]);
    return true;
  }

  async removeContainer(containerId: string): Promise<boolean> {
    const safeId = sanitizeContainerId(containerId);
    // `-f` ensures removal even of a running container; no `-v`, so named
    // volumes are never deleted as a side effect.
    await this.runDocker(["rm", "-f", safeId]);
    return true;
  }
}
