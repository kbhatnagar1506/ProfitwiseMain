import { NextRequest, NextResponse } from "next/server"
import IntuitOAuth from "intuit-oauth"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { log } from "@/lib/logger"
import { cookies } from "next/headers"

const QB_SCOPE = "com.intuit.quickbooks.accounting"
const STATE_COOKIE = "qbo_oauth_state"

export async function GET(request: NextRequest) {
  const token = request.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    log("qbo.authorize.unauthorized", { reason: "no_session" }, "qbo")
    const base = (process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? request.nextUrl.origin).replace(/\/$/, "")
    return NextResponse.redirect(new URL("/", base), 302)
  }
  const clientId = process.env.QUICKBOOKS_CLIENT_ID
  const clientSecret = process.env.QUICKBOOKS_CLIENT_SECRET
  const appUrl = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL
  const redirectUri = appUrl ? `${appUrl}/api/quickbooks/oauth/callback` : undefined

  if (!clientId || !clientSecret || !redirectUri) {
    log("oauth.authorize.rejected", { reason: "missing_env", hasClientId: !!clientId, hasRedirectUri: !!redirectUri })
    return NextResponse.json({ error: "QuickBooks OAuth not configured" }, { status: 500 })
  }

  log("oauth.authorize.started", { redirectUri: redirectUri.replace(/\?.*/, "") })

  const OAuthClient = "default" in IntuitOAuth ? (IntuitOAuth as { default: new (c: object) => { authorizeUri: (p: { scope: string[]; state: string }) => string } }).default : IntuitOAuth
  const oauthClient = new OAuthClient({
    clientId,
    clientSecret,
    redirectUri,
    environment: process.env.QUICKBOOKS_SANDBOX === "true" ? "sandbox" : "production",
  })

  const state = crypto.randomUUID()
  const authUri = oauthClient.authorizeUri({
    scope: [QB_SCOPE],
    state,
  })

  const cookieStore = await cookies()
  const cookieValue = JSON.stringify({ state, userId: user.id })
  cookieStore.set(STATE_COOKIE, cookieValue, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 10,
    path: "/",
  })

  log("oauth.authorize.redirecting", { destination: "intuit" })
  return NextResponse.redirect(authUri, 302)
}
