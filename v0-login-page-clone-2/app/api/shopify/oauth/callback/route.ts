import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { log, error as logError } from "@/lib/logger"
import {
  exchangeCodeForAccessToken,
  getMissingScopes,
  normalizeShopDomain,
  parseScopeString,
  verifyShopifyCallbackHmac,
} from "@/lib/shopify"
import { setShopifyConnection } from "@/lib/shopify-token-store"

const STATE_COOKIE = "shopify_oauth_state"

type StateCookie = {
  state?: string
  userId?: string
  shopDomain?: string
}

function redirectBase(request: NextRequest): string {
  const appUrl = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL
  if (appUrl) return appUrl.replace(/\/$/, "")
  return request.nextUrl.origin
}

export async function GET(request: NextRequest) {
  const base = redirectBase(request)
  const query = request.nextUrl.searchParams
  const code = query.get("code")
  const state = query.get("state")
  const shop = query.get("shop")
  const oauthError = query.get("error")

  if (oauthError) {
    logError("shopify.oauth.callback.failed", new Error(oauthError), "shopify")
    return NextResponse.redirect(new URL(`/onboarding?error=shopify_${encodeURIComponent(oauthError)}`, base), 302)
  }
  if (!code || !state || !shop) {
    return NextResponse.redirect(new URL("/onboarding?error=shopify_missing_params", base), 302)
  }

  if (!verifyShopifyCallbackHmac(query)) {
    logError("shopify.oauth.callback.failed", new Error("invalid_hmac"), "shopify")
    return NextResponse.redirect(new URL("/onboarding?error=shopify_invalid_hmac", base), 302)
  }

  const cookieStore = await cookies()
  const stateCookie = cookieStore.get(STATE_COOKIE)?.value
  cookieStore.delete(STATE_COOKIE)
  if (!stateCookie) {
    return NextResponse.redirect(new URL("/onboarding?error=shopify_state_missing", base), 302)
  }

  let cookieState: StateCookie = {}
  try {
    cookieState = JSON.parse(stateCookie) as StateCookie
  } catch {
    return NextResponse.redirect(new URL("/onboarding?error=shopify_state_invalid", base), 302)
  }

  if (!cookieState.userId || !cookieState.state || cookieState.state !== state) {
    return NextResponse.redirect(new URL("/onboarding?error=shopify_state_mismatch", base), 302)
  }

  let shopDomain = ""
  try {
    shopDomain = normalizeShopDomain(shop)
  } catch {
    return NextResponse.redirect(new URL("/onboarding?error=shopify_invalid_shop", base), 302)
  }

  if (cookieState.shopDomain && cookieState.shopDomain !== shopDomain) {
    return NextResponse.redirect(new URL("/onboarding?error=shopify_state_shop_mismatch", base), 302)
  }

  try {
    const tokenResponse = await exchangeCodeForAccessToken(shopDomain, code)
    const grantedScopes = parseScopeString(tokenResponse.scope)
    const missingScopes = getMissingScopes(grantedScopes)

    await setShopifyConnection(cookieState.userId, shopDomain, {
      accessToken: tokenResponse.access_token,
      scope: tokenResponse.scope,
      grantedScopes,
      missingScopes,
    })

    log("shopify.oauth.callback.succeeded", { userId: cookieState.userId, shopDomain, missingScopes: missingScopes.length }, "shopify")
    const qp = new URLSearchParams({
      connected: "shopify",
      shop: shopDomain,
      status: missingScopes.length ? "scope_missing" : "connected",
    })
    return NextResponse.redirect(new URL(`/onboarding?${qp.toString()}`, base), 302)
  } catch (err) {
    logError("shopify.oauth.callback.failed", err, "shopify")
    return NextResponse.redirect(new URL("/onboarding?error=shopify_token_exchange", base), 302)
  }
}
