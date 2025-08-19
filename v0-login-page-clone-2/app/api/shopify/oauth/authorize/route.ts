import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { log } from "@/lib/logger"
import { getAuthUrl, normalizeShop } from "@/lib/shopify"
import { cookies } from "next/headers"

const STATE_COOKIE = "shopify_oauth_state"

export async function GET(request: NextRequest) {
  const token = request.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  const base = (process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? request.nextUrl.origin).replace(/\/$/, "")

  if (!user) {
    log("shopify.authorize.unauthorized", { reason: "no_session" }, "shopify")
    return NextResponse.redirect(new URL("/", base), 302)
  }

  const shopParam = request.nextUrl.searchParams.get("shop")
  const shop = shopParam ? normalizeShop(shopParam) : ""
  if (!shop || !shop.endsWith(".myshopify.com")) {
    return NextResponse.redirect(new URL("/onboarding?error=shopify_invalid_shop", base), 302)
  }

  try {
    const state = crypto.randomUUID()
    const authUrl = getAuthUrl(shop, state)
    const cookieStore = await cookies()
    cookieStore.set(STATE_COOKIE, JSON.stringify({ state, userId: user.id, shop }), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 10,
      path: "/",
    })
    log("shopify.authorize.redirecting", { shop }, "shopify")
    return NextResponse.redirect(authUrl, 302)
  } catch (err) {
    log("shopify.authorize.failed", { error: err instanceof Error ? err.message : String(err) }, "shopify")
    return NextResponse.redirect(new URL("/onboarding?error=shopify_config", base), 302)
  }
}
