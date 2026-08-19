import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { DockerComposeAdapter } from "../agent/src/docker/compose-adapter";

function fakeChild(code: number, stdout = "", stderr = ""): unknown {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setImmediate(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.emit("close", code);
  });
  return child;
}

// Commands that would destroy/mutate beyond the allowed apply/pull surface.
const DESTRUCTIVE = ["down", "rm", "remove-orphans", "volume", "network", "kill", "run", "exec"];

describe("agent compose adapter — safety whitelist (6B)", () => {
  beforeEach(() => spawnMock.mockReset());

  it("up -d never includes down/rm/--remove-orphans", async () => {
    spawnMock.mockImplementation(() => fakeChild(0, "", ""));
    const adapter = new DockerComposeAdapter();
    await adapter.upDetached("/tmp/d", { A: "1" }, "proj");
    const args = spawnMock.mock.calls[0][1];
    expect(args[0]).toBe("compose");
    expect(args).toContain("up");
    expect(args).toContain("-d");
    expect(args).toContain("proj");
    for (const bad of ["down", "rm", "--remove-orphans", "remove-orphans", "volume", "network"]) {
      expect(args).not.toContain(bad);
    }
  });

  it("pull never includes down/rm", async () => {
    spawnMock.mockImplementation(() => fakeChild(0, "", ""));
    const adapter = new DockerComposeAdapter();
    await adapter.pull("/tmp/d", {}, "proj");
    const args = spawnMock.mock.calls[0][1];
    expect(args).toContain("pull");
    expect(args).not.toContain("down");
    expect(args).not.toContain("rm");
  });

  it("exposes no destructive compose subcommands as methods", () => {
    const adapter = new DockerComposeAdapter();
    const methodNames = Object.getOwnPropertyNames(Object.getPrototypeOf(adapter));
    for (const bad of DESTRUCTIVE) {
      expect(methodNames).not.toContain(bad);
    }
  });

  it("spawn is always called with 'docker' + an args array, never a shell", () => {
    const adapter = new DockerComposeAdapter();
    void adapter;
    // The adapter is not invoked here; the structural assertion is that every
    // spawn call is `spawn("docker", ["compose", ...])` — args array, no shell.
    spawnMock.mockImplementation(() => fakeChild(0, "", ""));
    const a = new DockerComposeAdapter();
    return a.version().then(() => {
      const [cmd, args] = spawnMock.mock.calls[0];
      expect(cmd).toBe("docker");
      expect(Array.isArray(args)).toBe(true);
      expect(args[0]).toBe("compose");
    });
  });
});
