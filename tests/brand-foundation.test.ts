import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BRAND } from "@/lib/brand";

const root = process.cwd();

function pngSize(file: string): [number, number] {
  const bytes = readFileSync(join(root, "public/brand", file));
  expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

describe("Noderaft brand foundation", () => {
  it("keeps product and agent naming canonical", () => {
    expect(BRAND).toMatchObject({
      productName: "Noderaft",
      wordmark: "noderaft",
      technicalName: "noderaft",
      agentName: "Noderaft Agent"
    });
  });

  it("defines the authoritative core palette as centralized CSS tokens", () => {
    const css = readFileSync(join(root, "app/globals.css"), "utf8");
    expect(css).toContain("--surface-hull: 5 7 13;");
    expect(css).toContain("--surface-deck: 12 19 34;");
    expect(css).toContain("--surface-raised: 17 26 44;");
    expect(css).toContain("--border-default: 31 42 68;");
    expect(css).toContain("--text-muted: 138 160 200;");
    expect(css).toContain("--text-primary: 233 241 255;");
    expect(css).toContain("--brand-accent: 51 209 255;");
    expect(css).toContain("--brand-hover: 127 227 255;");
  });

  it("ships correctly sized production raster assets", () => {
    expect(pngSize("favicon-16.png")).toEqual([16, 16]);
    expect(pngSize("favicon-32.png")).toEqual([32, 32]);
    expect(pngSize("apple-touch-icon.png")).toEqual([180, 180]);
    expect(pngSize("icon-192.png")).toEqual([192, 192]);
    expect(pngSize("icon-512.png")).toEqual([512, 512]);
    expect(pngSize("og-image.png")).toEqual([1200, 630]);
  });
});
