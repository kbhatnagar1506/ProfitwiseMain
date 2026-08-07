import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSlackClientId, getSlackClientSecret } from "@/lib/slack"
import { upsertSlackConnection } from "@/lib/slack-user"

const STATE_COOKIE = "slack_oauth_state"

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get("code")
  const state = searchParams.get("state")
  const errorParam = searchParams.get("error")
  const base = (process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? request.nextUrl.origin).replace(/\/$/, "")

  if (errorParam) {
    return NextResponse.redirect(new URL(`/onboarding?error=slack_${errorParam}`, base), 302)
  }
  if (!code) {
    return NextResponse.redirect(new URL("/onboarding?error=slack_missing_code", base), 302)
  }

  const cookieStore = await cookies()
  const stateCookie = cookieStore.get(STATE_COOKIE)?.value
  cookieStore.delete(STATE_COOKIE)

  let userId: string | undefined
  if (stateCookie) {
    try {
      const parsed = JSON.parse(stateCookie) as { state?: string; userId?: string }
      if (parsed.state && state === parsed.state) userId = parsed.userId
    } catch {
      // ignore
    }
  }
  if (!userId) {
    return NextResponse.redirect(new URL("/onboarding?error=slack_state_mismatch", base), 302)
  }

  const clientId = getSlackClientId()
  const clientSecret = getSlackClientSecret()
  if (!clientId || !clientSecret) {
    return NextResponse.redirect(new URL("/onboarding?error=slack_not_configured", base), 302)
  }
  const redirectUri = `${base}/api/slack/oauth/callback`
  const res = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  })
  if (!res.ok) {
    return NextResponse.redirect(new URL("/onboarding?error=slack_token_exchange", base), 302)
  }
  const data = (await res.json()) as {
    ok?: boolean
    authed_user?: { id?: string }
    team?: { id?: string }
    access_token?: string
    error?: string
  }
  if (!data.ok || !data.access_token || !data.authed_user?.id || !data.team?.id) {
    return NextResponse.redirect(new URL("/onboarding?error=slack_token_exchange", base), 302)
  }
  await upsertSlackConnection(userId, data.authed_user.id, data.team.id, data.access_token)
  return NextResponse.redirect(new URL("/onboarding", base), 302)
}
