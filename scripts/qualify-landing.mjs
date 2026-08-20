#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const baseUrl = process.env.NODERAFT_LANDING_URL ?? "http://127.0.0.1:3103/landing";
const outputDir = process.env.NODERAFT_LANDING_SCREEN_DIR ?? "/home/rene/.openclaw/workspace/artifacts/noderaft-6f3-screens";

const viewports = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "laptop", width: 1280, height: 800 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "mobile", width: 390, height: 844 }
];

fs.mkdirSync(outputDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    return;
  }

  failures += 1;
  console.error(`  ✗ ${message}`);
}

try {
  for (const viewport of viewports) {
    const page = await browser.newPage({ viewport });
    const browserErrors = [];
    const failedRequests = [];

    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("requestfailed", (request) => failedRequests.push(`${request.method()} ${request.url()}`));

    const response = await page.goto(baseUrl, { waitUntil: "networkidle" });
    console.log(`\n${viewport.name} (${viewport.width}×${viewport.height})`);

    check(response?.status() === 200, "landing route returns HTTP 200");
    check(await page.title() === "Noderaft — Docker fleet operations, on one deck", "title is canonical");
    const canonicalHref = await page.locator('link[rel="canonical"]').getAttribute("href");
    check(canonicalHref !== null && new URL(canonicalHref).origin === "https://noderaft.ee" && new URL(canonicalHref).pathname === "/", "canonical URL is public origin");
    check(await page.locator('meta[name="description"]').count() === 1, "meta description is present once");
    check(await page.locator('meta[property="og:image"]').getAttribute("content") === "https://noderaft.ee/brand/og-image.png", "OpenGraph image uses public origin");
    check(await page.getByRole("link", { name: /open platform/i }).first().getAttribute("href") === "https://platform.noderaft.ee", "primary CTA targets the platform origin");

    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth
    }));
    check(dimensions.document <= dimensions.viewport && dimensions.body <= dimensions.viewport, `no horizontal overflow (${dimensions.document}/${dimensions.viewport}px)`);

    const mobileMenu = page.locator("header details");
    if (viewport.width < 768) {
      check(await mobileMenu.isVisible(), "purpose-built mobile navigation is visible");
      await mobileMenu.locator("summary").click();
      check(await mobileMenu.locator('nav[aria-label="Mobile navigation"]').isVisible(), "mobile navigation opens");
      await mobileMenu.locator("summary").click();
    } else {
      check(!(await mobileMenu.isVisible()), "mobile navigation is hidden at desktop/tablet breakpoint");
      check(await page.locator('nav[aria-label="Primary navigation"]').isVisible(), "desktop navigation is visible");
    }

    check(browserErrors.length === 0, `no browser errors${browserErrors.length ? `: ${browserErrors.join(" | ")}` : ""}`);
    check(failedRequests.length === 0, `no failed requests${failedRequests.length ? `: ${failedRequests.join(" | ")}` : ""}`);

    await page.screenshot({
      path: path.join(outputDir, `${viewport.name}-${viewport.width}x${viewport.height}.png`),
      fullPage: true
    });

    if (viewport.name === "desktop") {
      const resources = await page.evaluate(() => performance.getEntriesByType("resource").map((entry) => ({
        name: entry.name,
        transferSize: "transferSize" in entry ? entry.transferSize : 0
      })));
      const scripts = resources.filter((resource) => resource.name.includes("/_next/static/") && resource.name.endsWith(".js"));
      const transferred = scripts.reduce((sum, resource) => sum + resource.transferSize, 0);
      console.log(`  ℹ Next.js scripts requested: ${scripts.length}; transferred: ${Math.round(transferred / 1024)} KiB`);
    }

    await page.close();
  }
} finally {
  await browser.close();
}

if (failures > 0) {
  console.error(`\nLanding qualification failed with ${failures} assertion(s).`);
  process.exit(1);
}

console.log(`\nLanding qualification passed. Screenshots: ${outputDir}`);
