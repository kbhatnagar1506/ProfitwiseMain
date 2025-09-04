import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import {
  exchangeGmailCode,
  saveGmailConnection,
  getGmailOAuthConfig,
} from "@/lib/gmail-oauth"

const STATE_COOKIE = "gmail_oauth_state"
const CONNECTION_ID = "inbox"

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get("code")
  const state = searchParams.get("state")
  const errorParam = searchParams.get("error")
  const base = (process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? request.nextUrl.origin).replace(/\/$/, "")
  const successRedirect = `${base}/oauth/gmail?connected=1`
  const failRedirect = (err: string) => `${base}/oauth/gmail?error=${encodeURIComponent(err)}`

  if (errorParam) {
    return NextResponse.redirect(failRedirect(`oauth_${errorParam}`), 302)
  }
  if (!code) {
    return NextResponse.redirect(failRedirect("missing_code"), 302)
  }

  const cookieStore = await cookies()
  const stateCookie = cookieStore.get(STATE_COOKIE)?.value
  cookieStore.delete(STATE_COOKIE)

  let stateMatch = false
  if (stateCookie) {
    try {
      const parsed = JSON.parse(stateCookie) as { state?: string }
      stateMatch = parsed.state != null && state === parsed.state
    } catch {
      // ignore
    }
  }
  if (!stateMatch) {
    return NextResponse.redirect(failRedirect("state_mismatch"), 302)
  }

  const config = getGmailOAuthConfig()
  if (!config) {
    return NextResponse.redirect(failRedirect("not_configured"), 302)
  }

  const redirectUri = `${base}/api/gmail/oauth/callback`
  const tokens = await exchangeGmailCode(code, redirectUri)
  if (tokens.error || !tokens.access_token) {
    return NextResponse.redirect(failRedirect(tokens.error ?? "token_exchange_failed"), 302)
  }
  const refreshToken = tokens.refresh_token
  if (!refreshToken) {
    return NextResponse.redirect(failRedirect("no_refresh_token"), 302)
  }

  let email: string | null = null
  try {
    const profileRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })
    if (profileRes.ok) {
      const profile = (await profileRes.json()) as { email?: string }
      email = profile.email ?? null
    }
  } catch {
    // ignore
  }

  await saveGmailConnection(
    CONNECTION_ID,
    refreshToken,
    tokens.access_token,
    tokens.expires_in ?? undefined,
    email
  )

  return NextResponse.redirect(successRedirect, 302)
}
