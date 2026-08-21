import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Docker Compose adapter (Phase 6A validation + Phase 6B execution).
 *
 * Explicit subcommand whitelist: `version`, `config`, `pull`, `up -d`, `ps`.
 * No `down`, `rm`, `run`, `exec`, `kill`, `--remove-orphans`, volume/network
 * deletion. Arguments are passed as an array to spawn(), never through a shell.
 *
 * The child process environment is DELIBERATELY RESTRICTED — never the full
 * agent process.env (which would expose agent/TLS/credential secrets).
 */

export type ComposeConfigResult = {
  ok: boolean;
  normalized: string | null;
  errors: string[];
};

const MAX_COMPOSE_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;

/** Restricted child environment: OS essentials + docker vars + resolved env only. */
function buildChildEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    LANG: process.env.LANG ?? "C.UTF-8",
    NODE_ENV: process.env.NODE_ENV ?? ""
  };
  if (process.env.DOCKER_HOST) env.DOCKER_HOST = process.env.DOCKER_HOST;
  if (process.env.XDG_RUNTIME_DIR) env.XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR;
  for (const [k, v] of Object.entries(extra)) {
    env[k] = v;
  }
  return env;
}

export class DockerComposeAdapter {
  private static inFlight = new Map<string, import("node:child_process").ChildProcess>();

  /** Best-effort terminate an in-flight compose command for a deployment. */
  static abort(key: string): void {
    const child = DockerComposeAdapter.inFlight.get(key);
    if (child) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      DockerComposeAdapter.inFlight.delete(key);
    }
  }

  /** Fixed, whitelisted compose invocations only. */
  private runCompose(
    args: string[],
    env: Record<string, string>,
    trackKey?: string
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn("docker", ["compose", ...args], {
        env: buildChildEnv(env),
        stdio: ["ignore", "pipe", "pipe"]
      });
      if (trackKey) DockerComposeAdapter.inFlight.set(trackKey, child);

      let stdout = "";
      let stderr = "";
      let overflow = false;
      child.stdout.on("data", (chunk: Buffer) => {
        if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString();
        else overflow = true;
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString();
        else overflow = true;
      });
      child.on("error", (err) => {
        if (trackKey) DockerComposeAdapter.inFlight.delete(trackKey);
        reject(err);
      });
      child.on("close", (code) => {
        if (trackKey) DockerComposeAdapter.inFlight.delete(trackKey);
        if (overflow) stderr += "\n[output truncated]";
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });
  }

  async version(): Promise<string | null> {
    try {
      const { code, stdout } = await this.runCompose(["version", "--short"], {});
      if (code !== 0) return null;
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  async config(compose: string, env: Record<string, string>): Promise<ComposeConfigResult> {
    if (compose.length === 0 || Buffer.byteLength(compose, "utf8") > MAX_COMPOSE_BYTES) {
      return { ok: false, normalized: null, errors: ["Invalid compose payload size"] };
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hostpanel-compose-"));
    try {
      fs.writeFileSync(path.join(dir, "compose.yml"), compose, { mode: 0o600 });
      const { code, stdout, stderr } = await this.runCompose(
        ["-f", path.join(dir, "compose.yml"), "config"],
        env
      );
      if (code !== 0) {
        return { ok: false, normalized: null, errors: [stderr.trim() || "docker compose config failed"] };
      }
      return { ok: true, normalized: stdout, errors: [] };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /** `docker compose pull` for a materialized revision dir. */
  async pull(composeDir: string, env: Record<string, string>, projectName: string, trackKey?: string): Promise<{ code: number; stderr: string }> {
    return this.runCompose(["-p", projectName, "-f", path.join(composeDir, "compose.yml"), "pull"], env, trackKey);
  }

  /** `docker compose up -d`. No `--remove-orphans`, no `--force-recreate`. */
  async upDetached(composeDir: string, env: Record<string, string>, projectName: string, trackKey?: string): Promise<{ code: number; stderr: string }> {
    return this.runCompose(["-p", projectName, "-f", path.join(composeDir, "compose.yml"), "up", "-d"], env, trackKey);
  }

  /** `docker compose ps --format json`. */
  async psJson(composeDir: string, env: Record<string, string>, projectName: string): Promise<{ code: number; stdout: string; stderr: string }> {
    return this.runCompose(["-p", projectName, "-f", path.join(composeDir, "compose.yml"), "ps", "--format", "json"], env);
  }

  /** `docker compose config --services` (expected service names, newline-separated). */
  async configServices(composeDir: string, env: Record<string, string>, projectName: string): Promise<{ code: number; stdout: string; stderr: string }> {
    return this.runCompose(["-p", projectName, "-f", path.join(composeDir, "compose.yml"), "config", "--services"], env);
  }

  /**
   * Batched runtime image identity for a set of containers:
   * `docker inspect <ids...>` returns .Image (local image ID) and .Config.Image
   * (the reference used). A single call regardless of workload size — no N+1.
   */
  async inspectContainerImages(containerIds: string[], env: Record<string, string>): Promise<
    Array<{ containerId: string; imageId: string | null; imageRef: string | null }>
  > {
    if (containerIds.length === 0) return [];
    const safe = containerIds.filter((id) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,127}$/.test(id)).slice(0, 200);
    if (safe.length === 0) return [];
    const { code, stdout } = await this.runDocker(["inspect", ...safe, "--format", "{{json .}}"], env);
    if (code !== 0) return [];
    const out: Array<{ containerId: string; imageId: string | null; imageRef: string | null }> = [];
    for (const line of stdout.trim().split("\n").filter(Boolean)) {
      try {
        const raw = JSON.parse(line) as { Id?: string; Image?: string; Config?: { Image?: string } };
        out.push({
          containerId: raw.Id ?? "",
          imageId: raw.Image ?? null,
          imageRef: raw.Config?.Image ?? null
        });
      } catch {
        /* skip unparseable */
      }
    }
    return out;
  }

  /**
   * Batched repo digests for image IDs: `docker image inspect <ids...>` →
   * .RepoDigests[0]. Nullable when the image was never pulled from a registry.
   */
  async inspectImageDigests(imageIds: string[], env: Record<string, string>): Promise<Map<string, string | null>> {
    const result = new Map<string, string | null>();
    const safe = Array.from(new Set(imageIds.filter((id) => /^[a-zA-Z0-9:@._-]{2,200}$/.test(id)))).slice(0, 200);
    if (safe.length === 0) return result;
    const { code, stdout } = await this.runDocker(["image", "inspect", ...safe, "--format", "{{json .}}"], env);
    if (code !== 0) return result;
    for (const line of stdout.trim().split("\n").filter(Boolean)) {
      try {
        const raw = JSON.parse(line) as { Id?: string; RepoDigests?: string[] };
        if (raw.Id) result.set(raw.Id, raw.RepoDigests?.[0] ?? null);
      } catch {
        /* skip */
      }
    }
    return result;
  }

  /**
   * Full `docker inspect` of ONE container as raw JSON. Used by the adoption
   * preflight to reconstruct a compose definition that matches the running
   * container — read-only.
   */
  async inspectContainerFull(containerId: string): Promise<unknown> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,127}$/.test(containerId)) {
      throw new Error("Invalid container id");
    }
    const { code, stdout, stderr } = await this.runDocker(["inspect", containerId, "--format", "{{json .}}"], {});
    if (code !== 0) {
      throw new Error(stderr.trim() || "docker inspect failed");
    }
    return JSON.parse(stdout) as unknown;
  }

  /**
   * Add labels to an EXISTING container without stopping or restarting it
   * (`docker container update --label-add`). Used by adoption to mark the
   * live container as belonging to the new compose project so that the FIRST
   * compose-managed deploy can reconcile it in place. Non-destructive: no
   * stop/restart/remove, and labels only ever get added.
   */
  async updateContainerLabels(containerId: string, labels: Record<string, string>): Promise<void> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,127}$/.test(containerId)) {
      throw new Error("Invalid container id");
    }
    const args = ["container", "update"];
    for (const [k, v] of Object.entries(labels)) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(k)) continue;
      args.push("--label-add", `${k}=${v.slice(0, 500)}`);
    }
    if (args.length === 2) return;
    const { code, stderr } = await this.runDocker(args, {});
    if (code !== 0) {
      throw new Error(stderr.trim() || "docker container update failed");
    }
  }

  /** Plain `docker` invocation (argument array, never a shell). Read-only uses only. */
  private runDocker(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn("docker", args, { env: buildChildEnv(env), stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => {
        if (stdout.length < MAX_OUTPUT_BYTES) stdout += c.toString();
      });
      child.stderr.on("data", (c: Buffer) => {
        if (stderr.length < MAX_OUTPUT_BYTES) stderr += c.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  }
}
