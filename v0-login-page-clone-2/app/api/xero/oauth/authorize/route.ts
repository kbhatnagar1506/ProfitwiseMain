import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { log } from "@/lib/logger"
import { getAuthUrl } from "@/lib/xero"
import { cookies } from "next/headers"

const STATE_COOKIE = "xero_oauth_state"

export async function GET(request: NextRequest) {
  const token = request.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    log("xero.authorize.unauthorized", { reason: "no_session" }, "xero")
    const base = (process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? request.nextUrl.origin).replace(/\/$/, "")
    return NextResponse.redirect(new URL("/", base), 302)
  }
  if (!process.env.XERO_CLIENT_ID || !process.env.XERO_CLIENT_SECRET) {
    log("oauth.authorize.rejected", { reason: "not_configured" }, "xero")
    return NextResponse.json({ error: "Xero not configured" }, { status: 500 })
  }
  const state = crypto.randomUUID()
  const authUrl = getAuthUrl(state)
  const cookieStore = await cookies()
  const cookieValue = JSON.stringify({ state, userId: user.id })
  cookieStore.set(STATE_COOKIE, cookieValue, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 10,
    path: "/",
  })
  log("oauth.authorize.redirecting", { destination: "xero" }, "xero")
  return NextResponse.redirect(authUrl, 302)
}
