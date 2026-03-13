import { NextRequest, NextResponse } from "next/server";

const SESSION_COOKIE = "hostpanel_session";

export function middleware(request: NextRequest): NextResponse {
  const pathname = request.nextUrl.pathname;
  const hasSessionCookie = Boolean(request.cookies.get(SESSION_COOKIE)?.value);

  if ((pathname.startsWith("/admin") || pathname.startsWith("/client")) && !hasSessionCookie) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*", "/client/:path*"]
};
