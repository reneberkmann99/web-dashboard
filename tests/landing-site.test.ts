import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { BRAND } from "@/lib/brand";

const root = process.cwd();
const pageSource = readFileSync(join(root, "components/landing/landing-page.tsx"), "utf8");
const routeSource = readFileSync(join(root, "app/(public)/landing/page.tsx"), "utf8");

describe("Noderaft public landing site", () => {
  it("uses the canonical public and platform domains", () => {
    expect(BRAND.publicSiteUrl).toBe("https://noderaft.ee");
    expect(BRAND.platformUrl).toBe("https://platform.noderaft.ee");
    expect(pageSource).not.toContain("noderaft.io");
    expect(routeSource).not.toContain("noderaft.io");
  });

  it("does not publish unverified commercial or installer claims", () => {
    const prohibited = [
      "curl -fsSL",
      "€19",
      "14-day trial",
      "unlimited nodes",
      "community support",
      "priority support",
      "SLA",
      "SSO / SCIM",
      "self-host free"
    ];

    for (const claim of prohibited) {
      expect(pageSource).not.toContain(claim);
    }
  });

  it("keeps the landing page static and independent from platform providers", () => {
    expect(routeSource).toContain('export const dynamic = "force-static"');
    expect(pageSource).not.toContain('"use client"');
    expect(pageSource).not.toContain("QueryProvider");
    expect(pageSource).toContain("demo data");
  });

  it("publishes indexable SEO discovery routes for the public origin", () => {
    expect(robots()).toEqual({
      rules: {
        userAgent: "*",
        allow: "/",
        disallow: ["/admin/", "/client/", "/api/", "/login", "/activate", "/forbidden"]
      },
      sitemap: "https://noderaft.ee/sitemap.xml",
      host: "https://noderaft.ee"
    });
    expect(sitemap()).toEqual([
      {
        url: "https://noderaft.ee/",
        changeFrequency: "monthly",
        priority: 1
      }
    ]);
  });
});
