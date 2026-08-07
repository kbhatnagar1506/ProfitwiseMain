import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { getShopifyAuthorizeUrl, normalizeShopDomain } from "@/lib/shopify"
import { log, error as logError } from "@/lib/logger"

const STATE_COOKIE = "shopify_oauth_state"

export async function GET(request: NextRequest) {
  const token = request.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  const base = (process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? request.nextUrl.origin).replace(/\/$/, "")
  if (!user) {
    return NextResponse.redirect(new URL("/", base), 302)
  }

  const rawShop = request.nextUrl.searchParams.get("shop") ?? ""
  let shopDomain = ""
  try {
    shopDomain = normalizeShopDomain(rawShop)
  } catch {
    return NextResponse.redirect(new URL("/onboarding?error=shopify_invalid_shop", base), 302)
  }

  const state = crypto.randomUUID()
  const cookieStore = await cookies()
  cookieStore.set(
    STATE_COOKIE,
    JSON.stringify({
      state,
      userId: user.id,
      shopDomain,
    }),
    {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 10,
      path: "/",
    }
  )

  try {
    const authUrl = getShopifyAuthorizeUrl({
      shopDomain,
      state,
      origin: request.nextUrl.origin,
    })
    log("shopify.oauth.authorize.redirecting", { userId: user.id, shopDomain }, "shopify")
    return NextResponse.redirect(authUrl, 302)
  } catch (err) {
    logError("shopify.oauth.authorize.failed", err, "shopify")
    return NextResponse.redirect(new URL("/onboarding?error=shopify_config", base), 302)
  }
}
