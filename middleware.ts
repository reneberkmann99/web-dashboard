import { NextRequest, NextResponse } from "next/server";

const SESSION_COOKIE = "hostpanel_session";
const CSRF_COOKIE = "hostpanel_csrf";
const CSRF_HEADER = "x-csrf-token";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Endpoints that perform their own authentication and are exempt from the
// double-submit CSRF check (login/activation have no session yet; logout is
// a SameSite=Lax-protected no-op for cross-site attackers; agent enrollment
// is authenticated by a one-time token, not a browser session).
const CSRF_EXEMPT_PATHS = new Set([
  "/api/auth/login",
  "/api/auth/activate",
  "/api/auth/logout",
  "/api/agent/enroll"
]);

export function middleware(request: NextRequest): NextResponse {
  const pathname = request.nextUrl.pathname;
  const method = request.method;

  // Page-level gate (UX only — API routes enforce their own auth).
  const hasSessionCookie = Boolean(request.cookies.get(SESSION_COOKIE)?.value);
  if ((pathname.startsWith("/admin") || pathname.startsWith("/client")) && !hasSessionCookie) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // CSRF: double-submit cookie check for state-changing API calls.
  if (
    pathname.startsWith("/api") &&
    !SAFE_METHODS.has(method) &&
    !CSRF_EXEMPT_PATHS.has(pathname)
  ) {
    const cookie = request.cookies.get(CSRF_COOKIE)?.value;
    const header = request.headers.get(CSRF_HEADER);
    if (!cookie || !header || cookie !== header) {
      return NextResponse.json(
        { ok: false, error: { code: "CSRF", message: "Invalid or missing CSRF token" } },
        { status: 403 }
      );
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*", "/client/:path*", "/api/:path*"]
};
