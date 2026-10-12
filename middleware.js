import { NextResponse } from "next/server";

// Lightweight presence check at the edge. Full HMAC verification happens
// in the API routes (which run in Node). This just gates page access.
export function middleware(req) {
  const { pathname } = req.nextUrl;

  const isPublic =
    pathname.startsWith("/login") ||
    pathname.startsWith("/api/login") ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon");

  const session = req.cookies.get("mis_session");

  if (!isPublic && !session) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  // already logged in -> keep them off the login page
  if (pathname.startsWith("/login") && session) {
    const url = req.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Skip Next internals AND static image files (e.g. /logo.png) so they load
  // without the login redirect. Real pages and APIs are still gated.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico)).*)"],
};
