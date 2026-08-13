import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { getStripeAuthorizeUrl } from "@/lib/stripe"
import { log } from "@/lib/logger"
import { cookies } from "next/headers"

const STATE_COOKIE = "stripe_oauth_state"

export async function GET(request: NextRequest) {
  const token = request.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    log("stripe.authorize.unauthorized", { reason: "no_session" }, "stripe")
    const base = (process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? request.nextUrl.origin).replace(/\/$/, "")
    return NextResponse.redirect(new URL("/", base), 302)
  }

  const state = crypto.randomUUID()
  const authUrl = getStripeAuthorizeUrl(state)

  const cookieStore = await cookies()
  const cookieValue = JSON.stringify({ state, userId: user.id })
  cookieStore.set(STATE_COOKIE, cookieValue, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 10,
    path: "/",
  })

  log("stripe.oauth.authorize.redirecting", { destination: "stripe", hasUserId: !!user.id }, "stripe")
  return NextResponse.redirect(authUrl, 302)
}

