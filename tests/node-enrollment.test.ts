import { beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { prisma } from "./helpers/db";
import { resetDatabase } from "./setup";
import { seedWorld } from "./helpers/fixtures";

async function enroll(body: unknown) {
  const req = new NextRequest("http://localhost/api/agent/enroll", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const { POST } = await import("@/app/api/agent/enroll/route");
  return POST(req);
}

function hash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

beforeAll(async () => {
  resetDatabase();
  await seedWorld();
});

describe("node enrollment", () => {
  it("enrolls a fresh node with a one-time token and returns a key exactly once", async () => {
    const rawToken = "enrolltoken0123456789abcdef";
    await prisma.nodeEnrollmentToken.create({
      data: {
        tokenHash: hash(rawToken),
        expiresAt: new Date(Date.now() + 15 * 60_000)
      }
    });

    const resp = await enroll({
      token: rawToken,
      agentVersion: "0.2.0",
      dockerVersion: "29.6.2",
      osInfo: { type: "Linux", release: "6.12", arch: "x64" },
      systemInfo: { hostname: "remote-node", cpuCount: 8, totalMemBytes: 16e9 },
      apiBaseUrl: "http://remote-node:8081"
    });

    expect(resp.status).toBe(201);
    const data = (await resp.json()).data;
    expect(data.nodeId).toBeTruthy();
    expect(data.apiKey).toMatch(/^[0-9a-f]{64}$/);

    // The node exists, is ONLINE, has its metadata, and the key is encrypted.
    const node = await prisma.node.findUniqueOrThrow({ where: { id: data.nodeId } });
    expect(node.status).toBe("ONLINE");
    expect(node.agentVersion).toBe("0.2.0");
    expect(node.dockerVersion).toBe("29.6.2");
    expect(node.apiKeyEncrypted).not.toContain(data.apiKey); // never plaintext
    expect(node.apiKeyEncrypted).toContain(":"); // iv:tag:ciphertext

    // Token consumed — reuse is rejected.
    const again = await enroll({
      token: rawToken,
      agentVersion: "0.2.0"
    });
    expect(again.status).toBe(401);
  });

  it("rejects expired tokens", async () => {
    const rawToken = "expiredtoken0123456789ab";
    await prisma.nodeEnrollmentToken.create({
      data: {
        tokenHash: hash(rawToken),
        expiresAt: new Date(Date.now() - 1000)
      }
    });
    const resp = await enroll({ token: rawToken });
    expect(resp.status).toBe(401);
  });

  it("rejects unknown tokens", async () => {
    const resp = await enroll({ token: "nonexistent-token-123456789" });
    expect(resp.status).toBe(401);
  });

  it("rotates the API key when re-enrolling an existing node via a new token", async () => {
    const world = await seedWorld();
    const rawToken = "reenrolltoken0123456789ab";
    await prisma.nodeEnrollmentToken.create({
      data: {
        tokenHash: hash(rawToken),
        nodeId: world.node1.id,
        expiresAt: new Date(Date.now() + 15 * 60_000)
      }
    });

    const before = world.node1.apiKeyEncrypted;
    const resp = await enroll({
      token: rawToken,
      agentVersion: "0.3.0",
      dockerVersion: "30.0.0",
      apiBaseUrl: "http://agent:8081"
    });
    expect(resp.status).toBe(201);
    const after = await prisma.node.findUniqueOrThrow({ where: { id: world.node1.id } });
    expect(after.apiKeyEncrypted).not.toBe(before); // key rotated
    expect(after.agentVersion).toBe("0.3.0");
    expect(after.dockerVersion).toBe("30.0.0");
  });
});
