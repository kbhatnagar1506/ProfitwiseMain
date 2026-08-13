import { NextRequest, NextResponse } from "next/server"
import { SESSION_COOKIE_NAME } from "@/lib/session-cookie"

const PROTECTED_PATHS = ["/onboarding", "/dashboard", "/oauth"]

function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))
}

// Edge-safe: only check cookie presence. Session verification runs in Server Components (Node).
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  if (!isProtectedPath(pathname)) {
    return NextResponse.next()
  }

  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value
  if (!token) {
    return NextResponse.redirect(new URL("/", request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: ["/onboarding/:path*", "/dashboard/:path*", "/oauth/:path*"],
}
