import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resetDatabase } from "./setup";
import { seedWorld } from "./helpers/fixtures";
import { nodeAgentClient } from "@/server/services/node-agent/client";

let node: Awaited<ReturnType<typeof seedWorld>>["node1"];

beforeAll(async () => {
  resetDatabase();
  node = (await seedWorld()).node1;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("node agent action response contract", () => {
  it("does not treat HTTP 200 with success=false as a successful operation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ nodeOnline: true, success: false }),
      { status: 200, headers: { "content-type": "application/json" } }
    )));

    await expect(nodeAgentClient.runAction(node, "missing-container", "restart")).resolves.toBe(false);
  });

  it("accepts only a valid positive action response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ nodeOnline: true, success: true }),
      { status: 200, headers: { "content-type": "application/json" } }
    )));

    await expect(nodeAgentClient.runAction(node, "known-container", "restart")).resolves.toBe(true);
  });
});
