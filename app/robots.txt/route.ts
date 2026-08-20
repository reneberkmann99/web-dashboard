import { NextRequest } from "next/server";
import { BRAND } from "@/lib/brand";
import { robotsTextForHostname } from "@/lib/robots";

const PUBLIC_HOST = new URL(BRAND.publicSiteUrl).hostname;

function requestHostname(request: NextRequest): string {
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const rawHost = forwardedHost || request.headers.get("host") || request.nextUrl.hostname;
  return rawHost.replace(/:\d+$/, "").toLowerCase();
}

export function GET(request: NextRequest): Response {
  const hostname = requestHostname(request);
  const isPublic = hostname === PUBLIC_HOST;

  return new Response(robotsTextForHostname(hostname), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      ...(isPublic ? {} : { "X-Robots-Tag": "noindex, nofollow, noarchive" })
    }
  });
}
