import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { getSlackClientId } from "@/lib/slack"
import { cookies } from "next/headers"

const STATE_COOKIE = "slack_oauth_state"
const SLACK_SCOPE = "chat:write,im:read,im:write,im:history"

export async function GET(request: NextRequest) {
  const token = request.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    const base = (process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? request.nextUrl.origin).replace(/\/$/, "")
    return NextResponse.redirect(new URL("/", base), 302)
  }
  const clientId = getSlackClientId()
  if (!clientId) {
    return NextResponse.json({ error: "Slack not configured" }, { status: 500 })
  }
  const state = crypto.randomUUID()
  const cookieStore = await cookies()
  cookieStore.set(STATE_COOKIE, JSON.stringify({ state, userId: user.id }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 10,
    path: "/",
  })
  const appUrl = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "https://dashboard.profitwise.app"
  const redirectUri = `${appUrl.replace(/\/$/, "")}/api/slack/oauth/callback`
  const authUrl = `https://slack.com/oauth/v2/authorize?client_id=${encodeURIComponent(clientId)}&scope=${encodeURIComponent(SLACK_SCOPE)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}`
  return NextResponse.redirect(authUrl, 302)
}
