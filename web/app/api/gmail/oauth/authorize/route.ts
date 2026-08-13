import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { getGmailOAuthConfig, buildGmailAuthUrl } from "@/lib/gmail-oauth"
import { cookies } from "next/headers"

const STATE_COOKIE = "gmail_oauth_state"

const ADMIN_EMAIL = process.env.GMAIL_ADMIN_EMAIL?.toLowerCase().trim() // only this user can connect the single system inbox

export async function GET(request: NextRequest) {
  const base = (process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? request.nextUrl.origin).replace(/\/$/, "")
  const token = request.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    return NextResponse.redirect(new URL("/", base), 302)
  }
  if (ADMIN_EMAIL && user.email.toLowerCase() !== ADMIN_EMAIL) {
    return NextResponse.redirect(new URL("/oauth/gmail?error=admin_only", base), 302)
  }
  const config = getGmailOAuthConfig()
  if (!config) {
    return NextResponse.json({ error: "Gmail OAuth not configured" }, { status: 500 })
  }
  const redirectUri = `${base}/api/gmail/oauth/callback`
  const state = crypto.randomUUID()
  const cookieStore = await cookies()
  cookieStore.set(STATE_COOKIE, JSON.stringify({ state, userId: user.id }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 10,
    path: "/",
  })
  const authUrl = buildGmailAuthUrl(redirectUri, state)
  return NextResponse.redirect(authUrl, 302)
}
