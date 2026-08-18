import { beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { prisma } from "./helpers/db";
import { resetDatabase } from "./setup";
import { seedWorld } from "./helpers/fixtures";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { createSession, getCurrentSession } from "@/server/auth/session";
import { loginSchema } from "@/server/validation/auth";
import { activateAccountSchema } from "@/server/validation/admin";

async function postJson(path: string, body: unknown, headers: Record<string, string> = {}) {
  const req = new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
  const { POST } = await import("@/app/api/auth/login/route");
  const { POST: activate } = await import("@/app/api/auth/activate/route");
  const fn = path === "/api/auth/activate" ? activate : POST;
  return fn(req);
}

beforeAll(async () => {
  resetDatabase();
  await seedWorld();
});

describe("password hashing", () => {
  it("hashes with bcrypt and verifies correctly", async () => {
    const hash = await hashPassword("Sup3rSecret!42");
    expect(hash.startsWith("$2")).toBe(true);
    await expect(verifyPassword("Sup3rSecret!42", hash)).resolves.toBe(true);
    await expect(verifyPassword("wrong-password", hash)).resolves.toBe(false);
  });
});

describe("session lifecycle", () => {
  it("creates a hashed session and resolves it", async () => {
    const world = await seedWorld();
    const { token, expiresAt } = await createSession(world.clientAOperator.id);
    expect(token).toHaveLength(64);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

    // The raw token is NOT stored — only its sha256 hash.
    const rows = await prisma.session.findMany({ where: { userId: world.clientAOperator.id } });
    expect(rows.length).toBe(1);
    expect(rows[0].tokenHash).not.toBe(token);
    expect(
      crypto.createHash("sha256").update(token).digest("hex")
    ).toBe(rows[0].tokenHash);
  });
});

describe("login schema", () => {
  it("accepts emails and bare linux usernames, rejects empty", () => {
    expect(loginSchema.parse({ email: "rene", password: "x".repeat(8) }).email).toBe("rene");
    expect(loginSchema.parse({ email: "a@b.co", password: "x".repeat(8) }).email).toBe("a@b.co");
    expect(() => loginSchema.parse({ email: "", password: "" })).toThrow();
  });
});

describe("activation schema (password policy)", () => {
  it("requires >= 12 chars with letter and digit", () => {
    expect(activateAccountSchema.parse({ token: "t".repeat(32), password: "CorrectHorse42!" })).toBeTruthy();
    expect(() => activateAccountSchema.parse({ token: "t".repeat(32), password: "short1" })).toThrow();
    expect(() => activateAccountSchema.parse({ token: "t".repeat(32), password: "alllettersonly" })).toThrow();
    expect(() => activateAccountSchema.parse({ token: "t".repeat(32), password: "123456789012" })).toThrow();
  });
});

describe("activation + login flow", () => {
  it("blocks login for a pending (unactivated) account", async () => {
    // Create a pending user directly (as the admin route would).
    const world = await seedWorld();
    const pending = await prisma.user.create({
      data: {
        email: "pending@client-a.local",
        displayName: "Pending",
        passwordHash: null,
        role: "CLIENT_OPERATOR",
        clientAccountId: world.clientA.id,
        isActive: false
      }
    });
    await prisma.activationToken.create({
      data: {
        userId: pending.id,
        tokenHash: crypto.createHash("sha256").update("token-abc").digest("hex"),
        expiresAt: new Date(Date.now() + 3600_000)
      }
    });

    const resp = await postJson("/api/auth/login", {
      email: "pending@client-a.local",
      password: "Whatever123!"
    });
    expect(resp.status).toBe(403);
  });

  it("activates with a valid one-time token and auto-logs-in", async () => {
    const world = await seedWorld();
    const pending = await prisma.user.create({
      data: {
        email: "activate-me@client-a.local",
        displayName: "Activate Me",
        passwordHash: null,
        role: "CLIENT_OPERATOR",
        clientAccountId: world.clientA.id,
        isActive: false
      }
    });
    const raw = "activatetoken1234567890";
    await prisma.activationToken.create({
      data: {
        userId: pending.id,
        tokenHash: crypto.createHash("sha256").update(raw).digest("hex"),
        expiresAt: new Date(Date.now() + 3600_000)
      }
    });

    const resp = await postJson("/api/auth/activate", {
      token: raw,
      password: "BrandNewPass!99"
    });
    expect(resp.status).toBe(200);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: pending.id } });
    expect(after.isActive).toBe(true);
    expect(after.passwordHash).not.toBeNull();
    await expect(verifyPassword("BrandNewPass!99", after.passwordHash!)).resolves.toBe(true);

    // Token is consumed — reuse must fail.
    const again = await postJson("/api/auth/activate", {
      token: raw,
      password: "BrandNewPass!99"
    });
    expect(again.status).toBe(400);
  });

  it("rejects expired tokens", async () => {
    const world = await seedWorld();
    const pending = await prisma.user.create({
      data: {
        email: "expired@client-a.local",
        displayName: "Expired",
        passwordHash: null,
        role: "CLIENT_OPERATOR",
        clientAccountId: world.clientA.id,
        isActive: false
      }
    });
    await prisma.activationToken.create({
      data: {
        userId: pending.id,
        tokenHash: crypto.createHash("sha256").update("expiredtoken12345").digest("hex"),
        expiresAt: new Date(Date.now() - 1000)
      }
    });

    const resp = await postJson("/api/auth/activate", {
      token: "expiredtoken12345",
      password: "BrandNewPass!99"
    });
    expect(resp.status).toBe(400);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: pending.id } });
    expect(after.isActive).toBe(false);
  });
});
