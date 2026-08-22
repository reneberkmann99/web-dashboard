import { NextRequest, NextResponse } from "next/server";
import { BRAND } from "@/lib/brand";

const SESSION_COOKIE = "hostpanel_session";
const CSRF_COOKIE = "hostpanel_csrf";
const CSRF_HEADER = "x-csrf-token";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const PUBLIC_HOST = new URL(BRAND.publicSiteUrl).hostname;
const PLATFORM_ONLY_PREFIXES = ["/admin", "/client", "/organization", "/organizations", "/api", "/login", "/activate", "/forbidden"];

// Endpoints that perform their own authentication and are exempt from the
// double-submit CSRF check (login/activation have no session yet; logout is
// a SameSite=Lax-protected no-op for cross-site attackers; agent enrollment
// is authenticated by a one-time token, not a browser session).
const CSRF_EXEMPT_PATHS = new Set([
  "/api/auth/login",
  "/api/auth/activate",
  "/api/auth/logout",
  "/api/agent/enroll",
  // Agent-called, authenticated by a one-time enrollment token (no browser
  // session), so the double-submit cookie pattern does not apply.
  "/api/agent/tls-enroll"
]);

function randomCsrfToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function requestHostname(request: NextRequest): string {
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const rawHost = forwardedHost || request.headers.get("host") || request.nextUrl.hostname;
  return rawHost.replace(/:\d+$/, "").toLowerCase();
}

function applyIndexingBoundary(response: NextResponse, hostname: string): NextResponse {
  if (hostname !== PUBLIC_HOST) {
    response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  }
  return response;
}

export function middleware(request: NextRequest): NextResponse {
  const pathname = request.nextUrl.pathname;
  const method = request.method;
  const hostname = requestHostname(request);

  // The public hostname serves the statically generated landing page at its
  // canonical root. Platform-only surfaces are never presented on that host.
  if (hostname === PUBLIC_HOST) {
    if (pathname === "/") {
      return NextResponse.rewrite(new URL("/landing", request.url));
    }

    if (PLATFORM_ONLY_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
      return NextResponse.redirect(new URL("/", BRAND.publicSiteUrl), 307);
    }
  }

  // Page-level gate (UX only — API routes enforce their own auth).
  const sessionCookie = request.cookies.get(SESSION_COOKIE)?.value;
  const hasSessionCookie = Boolean(sessionCookie);
  if ((pathname.startsWith("/admin") || pathname.startsWith("/client") || pathname.startsWith("/organization") || pathname.startsWith("/organizations")) && !hasSessionCookie) {
    return applyIndexingBoundary(NextResponse.redirect(new URL("/login", request.url)), hostname);
  }

  const csrfCookie = request.cookies.get(CSRF_COOKIE)?.value;

  // CSRF: double-submit cookie check for state-changing API calls.
  let csrfFailed = false;
  if (
    pathname.startsWith("/api") &&
    !SAFE_METHODS.has(method) &&
    !CSRF_EXEMPT_PATHS.has(pathname)
  ) {
    const header = request.headers.get(CSRF_HEADER);
    csrfFailed = !csrfCookie || !header || csrfCookie !== header;
  }

  // Self-heal: a browser can hold a valid session cookie while its CSRF cookie
  // is absent — e.g. after a browser restart, or a session created before CSRF
  // protection shipped. Issue a fresh CSRF cookie so the double-submit header
  // matches on the next request. The CSRF check above still runs first, so a
  // mutating request that arrived without a token is still rejected.
  const shouldIssueCsrfCookie = hasSessionCookie && !csrfCookie;

  let response: NextResponse;
  if (csrfFailed) {
    response = NextResponse.json(
      { ok: false, error: { code: "CSRF", message: "Invalid or missing CSRF token" } },
      { status: 403 }
    );
  } else {
    response = NextResponse.next();
  }

  if (shouldIssueCsrfCookie) {
    response.cookies.set({
      name: CSRF_COOKIE,
      value: randomCsrfToken(),
      httpOnly: false,
      secure: process.env.COOKIE_SECURE === "true",
      sameSite: "lax",
      path: "/"
    });
  }

  return applyIndexingBoundary(response, hostname);
}

export const config = {
  matcher: ["/", "/login", "/activate", "/forbidden", "/admin/:path*", "/client/:path*", "/organization/:path*", "/organizations/:path*", "/api/:path*"]
};
