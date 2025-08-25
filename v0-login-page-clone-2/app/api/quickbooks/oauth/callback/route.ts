import { NextRequest, NextResponse } from "next/server"
import IntuitOAuth from "intuit-oauth"
import { getToken, setToken } from "@/lib/quickbooks-token-store"
import { log, error as logError } from "@/lib/logger"
import { cookies } from "next/headers"

const STATE_COOKIE = "qbo_oauth_state"

function redirectBase(): string {
  const appUrl = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL
  if (appUrl) return appUrl.replace(/\/$/, "")
  return ""
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get("code")
  const realmId = searchParams.get("realmId") ?? ""
  const state = searchParams.get("state")
  const base = redirectBase() || new URL(request.url).origin

  log("oauth.callback.received", { realmId, hasCode: !!code })

  if (!code || !realmId) {
    logError("oauth.callback.failed", new Error("missing_params"))
    return NextResponse.redirect(new URL("/onboarding?error=missing_params", base), 302)
  }

  const cookieStore = await cookies()
  const stateCookie = cookieStore.get(STATE_COOKIE)?.value
  cookieStore.delete(STATE_COOKIE)

  let userId: string | undefined
  if (stateCookie) {
    try {
      const parsed = JSON.parse(stateCookie) as { state?: string; userId?: string }
      if (parsed.state && state !== parsed.state) {
        logError("oauth.callback.failed", new Error("state_mismatch"))
        return NextResponse.redirect(new URL("/onboarding?error=state_mismatch", base), 302)
      }
      userId = parsed.userId
    } catch {
      if (state !== stateCookie) {
        logError("oauth.callback.failed", new Error("state_mismatch"))
        return NextResponse.redirect(new URL("/onboarding?error=state_mismatch", base), 302)
      }
    }
  }

  if (!userId) {
    logError("oauth.callback.failed", new Error("session_expired_no_user"))
    return NextResponse.redirect(new URL("/onboarding?error=session_expired", base), 302)
  }

  const clientId = process.env.QUICKBOOKS_CLIENT_ID
  const clientSecret = process.env.QUICKBOOKS_CLIENT_SECRET
  const appUrl = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL
  const redirectUri = appUrl ? `${appUrl.replace(/\/$/, "")}/api/quickbooks/oauth/callback` : undefined

  if (!clientId || !clientSecret || !redirectUri) {
    logError("oauth.callback.failed", new Error("not_configured"))
    return NextResponse.redirect(new URL("/onboarding?error=config", base), 302)
  }

  const OAuthClient = "default" in IntuitOAuth ? (IntuitOAuth as { default: new (c: object) => { createToken: (u: string) => Promise<{ getToken: () => { refresh_token: string; access_token: string; expires_in: number } }> } }).default : IntuitOAuth
  const oauthClient = new OAuthClient({
    clientId,
    clientSecret,
    redirectUri,
    environment: process.env.QUICKBOOKS_SANDBOX === "true" ? "sandbox" : "production",
  })

  const callbackUrl = `${base}/api/quickbooks/oauth/callback${new URL(request.url).search}`
  try {
    const authResponse = await oauthClient.createToken(callbackUrl)
    const token = authResponse.getToken()
    const expiresIn = typeof token.expires_in === "number" ? token.expires_in : parseInt(String(token.expires_in), 10) || 3600
    await setToken(
      realmId,
      {
        refreshToken: token.refresh_token,
        accessToken: token.access_token,
        expiresAt: Date.now() + expiresIn * 1000,
      },
      userId ? { userId } : undefined
    )
    log("oauth.callback.succeeded", { realmId })
  } catch (err) {
    logError("oauth.callback.failed", err)
    return NextResponse.redirect(new URL("/onboarding?error=token_exchange", base), 302)
  }

  return NextResponse.redirect(new URL("/onboarding", base), 302)
}
