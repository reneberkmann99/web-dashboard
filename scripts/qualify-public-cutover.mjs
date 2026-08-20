#!/usr/bin/env node

import fs from "node:fs";
import { chromium } from "@playwright/test";

const baseUrl = process.env.NODERAFT_PLATFORM_URL ?? "https://platform.noderaft.ee";
const longRunMs = Number(process.env.NODERAFT_SSE_LONG_RUN_MS ?? 65_000);

function readEnv(name) {
  const line = fs.readFileSync(".env", "utf8").split("\n").find((entry) => entry.startsWith(`${name}=`));
  if (!line) throw new Error(`Missing ${name} in .env`);
  return line.slice(name.length + 1).replace(/^"(.*)"$/, "$1");
}

function check(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`  ✓ ${message}`);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ baseURL: baseUrl });
const page = await context.newPage();
const streamRequests = [];
const streamResponses = [];

page.on("request", (request) => {
  if (request.url().includes("/logs/stream")) streamRequests.push(request.url());
});
page.on("response", async (response) => {
  if (response.url().includes("/logs/stream")) streamResponses.push(await response.allHeaders());
});

try {
  await page.goto("/login", { waitUntil: "networkidle" });
  await page.fill("#email", readEnv("SEED_ADMIN_EMAIL"));
  await page.fill("#password", readEnv("SEED_ADMIN_PASSWORD"));
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL(/\/admin(?:\/|$)/, { timeout: 20_000 });
  check(true, "authenticated through the public platform hostname");

  const target = await page.evaluate(async () => {
    const response = await fetch("/api/admin/containers?limit=100", { credentials: "include" });
    if (!response.ok) throw new Error(`container list returned HTTP ${response.status}`);
    const payload = await response.json();
    const container = payload.data.containers.find((item) => item.nodeOnline === true);
    if (!container) throw new Error("no online container available for SSE qualification");
    return { nodeId: container.nodeId, containerId: container.containerId };
  });

  await page.goto(`/admin/containers/${encodeURIComponent(target.nodeId)}/${encodeURIComponent(target.containerId)}`);
  await page.getByText("Live", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
  const logView = page.locator("pre.log-scroll");
  await logView.waitFor({ state: "visible" });
  check(streamRequests.length === 1, "one SSE connection opened initially");

  await page.waitForTimeout(longRunMs);
  check(streamRequests.length === 1, `SSE stayed stable for ${Math.round(longRunMs / 1000)} seconds across parent polling`);
  check(await page.getByText("Live", { exact: true }).isVisible(), "stream remained live for the long-running window");

  const initialText = await logView.textContent();
  await page.getByRole("button", { name: /pause live logs/i }).click();
  await page.waitForTimeout(3_000);
  check(await logView.textContent() === initialText, "pause freezes the rendered log view");
  await page.getByRole("button", { name: /resume live logs/i }).click();
  await page.waitForTimeout(3_000);
  check(streamRequests.length === 1, "pause/resume does not create a duplicate SSE connection");

  await page.getByLabel("Number of log lines").selectOption("100");
  await page.getByText("Live", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
  await page.waitForTimeout(3_000);
  check(streamRequests.length === 2, "controlled tail change reconnects exactly once");

  const reconnectedLines = (await logView.innerText()).split("\n").filter(Boolean);
  check(reconnectedLines.length <= 100, "reconnect replaces the tail instead of appending a duplicate buffer");

  const headers = streamResponses.at(-1) ?? {};
  check(headers["content-type"]?.startsWith("text/event-stream"), "SSE response keeps text/event-stream content type");
  check(headers["x-accel-buffering"] === "no", "NPM disables response buffering for SSE");
  check(headers["cache-control"]?.includes("no-cache") && headers["cache-control"]?.includes("no-transform"), "NPM disables SSE caching and transformation");

} finally {
  await context.close();
  await browser.close();
}

console.log("Public platform SSE qualification passed.");
