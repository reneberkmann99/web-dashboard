import { beforeAll, describe, expect, it, vi } from "vitest";
import { resetDatabase } from "./setup";
import { seedWorld } from "./helpers/fixtures";
import { agentLogsToSSE, MAX_LINE_BYTES } from "@/server/services/logs-stream";
import { nodeAgentClient } from "@/server/services/node-agent/client";

let world: Awaited<ReturnType<typeof seedWorld>>;
const encoder = new TextEncoder();

vi.mock("@/server/services/node-agent/client", () => ({
  nodeAgentClient: {
    listContainers: vi.fn(),
    getContainer: vi.fn(),
    getLogs: vi.fn(),
    runAction: vi.fn(),
    checkHealth: vi.fn(),
    getNodeInfo: vi.fn(),
    getStorageSummary: vi.fn(),
    inspectNetworks: vi.fn(),
    inspectVolumes: vi.fn(),
    streamLogs: vi.fn()
  }
}));

beforeAll(async () => {
  resetDatabase();
  world = await seedWorld();
});

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

describe("SSE log resource limits", () => {
  it("truncates an oversized single log line with a marker", async () => {
    const hugeLine = "a".repeat(100_000);
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`${hugeLine}\n`));
        controller.close();
      }
    });
    vi.mocked(nodeAgentClient.streamLogs).mockResolvedValue(source);

    const relay = agentLogsToSSE(world.node1, world.web.dockerContainerId, 200);
    const text = await collect(relay);

    expect(text).toContain("[log line truncated]");
    // The relayed data payload must stay well under the raw 100k input.
    expect(text.length).toBeLessThan(MAX_LINE_BYTES + 100);
  });

  it("bounds the pending buffer under a newline-free flood", async () => {
    // 3 MiB with no newline — must not be retained unboundedly.
    const flood = "b".repeat(3 * 1024 * 1024);
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(flood));
        controller.close();
      }
    });
    vi.mocked(nodeAgentClient.streamLogs).mockResolvedValue(source);

    const relay = agentLogsToSSE(world.node1, world.web.dockerContainerId, 200);
    const text = await collect(relay);

    // Total control-plane output is bounded to roughly the line cap, not the
    // 3 MiB input.
    expect(text.length).toBeLessThan(MAX_LINE_BYTES + 200);
    expect(text).toMatch(/\[log line truncated\]|\[buffer dropped\]/);
  });

  it("tears down the agent stream when the browser disconnects (cancel)", async () => {
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        // Keep the stream open; emit one line so the relay has started reading.
        controller.enqueue(encoder.encode("line-one\n"));
      },
      cancel() {
        cancelled = true;
      }
    });
    vi.mocked(nodeAgentClient.streamLogs).mockResolvedValue(source);

    const relay = agentLogsToSSE(world.node1, world.web.dockerContainerId, 200);
    const reader = relay.getReader();
    await reader.read(); // consume the first frame so the loop is active
    await reader.cancel();

    // Give the cancel handler a tick to run.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cancelled).toBe(true);
  });

  it("closes gracefully when the agent stream ends", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("hello\nworld\n"));
        controller.close();
      }
    });
    vi.mocked(nodeAgentClient.streamLogs).mockResolvedValue(source);

    const relay = agentLogsToSSE(world.node1, world.web.dockerContainerId, 200);
    const text = await collect(relay);
    expect(text).toContain("hello");
    expect(text).toContain("world");
  });
});
