import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { middleware } from "@/middleware";

describe("public domain cutover routing", () => {
  it("rewrites the public origin root to the static landing route", () => {
    const response = middleware(new NextRequest("https://noderaft.ee/"));
    expect(response.headers.get("x-middleware-rewrite")).toBe("https://noderaft.ee/landing");
    expect(response.headers.get("x-robots-tag")).toBeNull();
  });

  it("keeps platform-only pages off the landing hostname", () => {
    const response = middleware(new NextRequest("https://noderaft.ee/login"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://noderaft.ee/");
  });

  it("marks the canonical platform and recovery hosts noindex", () => {
    const platform = middleware(new NextRequest("https://platform.noderaft.ee/login"));
    const recovery = middleware(new NextRequest("https://10.99.2.1:1337/login"));

    expect(platform.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
    expect(recovery.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
  });
});
