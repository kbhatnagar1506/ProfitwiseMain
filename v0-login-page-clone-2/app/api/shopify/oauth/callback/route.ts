import { NextRequest, NextResponse } from "next/server"
import { log, error as logError } from "@/lib/logger"
import { cookies } from "next/headers"
import { verifyHmac, exchangeCodeForToken, storeConnection } from "@/lib/shopify"

const STATE_COOKIE = "shopify_oauth_state"

function paramsFromRequest(request: NextRequest): Record<string, string> {
  const o: Record<string, string> = {}
  request.nextUrl.searchParams.forEach((value, key) => {
    o[key] = value
  })
  return o
}

export async function GET(request: NextRequest) {
  const base = (process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? request.nextUrl.origin).replace(/\/$/, "")
  const params = paramsFromRequest(request)
  const { code, shop, state: stateParam } = params

  if (params.error) {
    logError("shopify.callback.failed", new Error(params.error), "shopify")
    return NextResponse.redirect(new URL(`/onboarding?error=shopify_${params.error}`, base), 302)
  }

  if (!code || !shop) {
    logError("shopify.callback.failed", new Error("missing_code_or_shop"), "shopify")
    return NextResponse.redirect(new URL("/onboarding?error=shopify_missing_params", base), 302)
  }

  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET ?? ""
  if (!clientSecret) {
    return NextResponse.redirect(new URL("/onboarding?error=shopify_config", base), 302)
  }
  if (!verifyHmac(params, clientSecret)) {
    logError("shopify.callback.failed", new Error("hmac_invalid"), "shopify")
    return NextResponse.redirect(new URL("/onboarding?error=shopify_hmac", base), 302)
  }

  const cookieStore = await cookies()
  const stateCookie = cookieStore.get(STATE_COOKIE)?.value
  cookieStore.delete(STATE_COOKIE)

  let userId: string | undefined
  if (stateCookie) {
    try {
      const parsed = JSON.parse(stateCookie) as { state?: string; userId?: string; shop?: string }
      if (parsed.state && stateParam !== parsed.state) {
        logError("shopify.callback.failed", new Error("state_mismatch"), "shopify")
        return NextResponse.redirect(new URL("/onboarding?error=shopify_state_mismatch", base), 302)
      }
      userId = parsed.userId
    } catch {
      if (stateParam !== stateCookie) {
        logError("shopify.callback.failed", new Error("state_mismatch"), "shopify")
        return NextResponse.redirect(new URL("/onboarding?error=shopify_state_mismatch", base), 302)
      }
    }
  }

  if (!userId) {
    logError("shopify.callback.failed", new Error("missing_user"), "shopify")
    return NextResponse.redirect(new URL("/onboarding?error=shopify_session", base), 302)
  }

  const shopDomain = shop.replace(/^https?:\/\//, "").split("/")[0]
  if (!shopDomain.endsWith(".myshopify.com")) {
    return NextResponse.redirect(new URL("/onboarding?error=shopify_invalid_shop", base), 302)
  }

  try {
    const { access_token, scope } = await exchangeCodeForToken(shopDomain, code)
    await storeConnection(userId, shopDomain, access_token, scope)
    log("shopify.callback.succeeded", { shop: shopDomain }, "shopify")
  } catch (err) {
    logError("shopify.callback.failed", err, "shopify")
    return NextResponse.redirect(new URL("/onboarding?error=shopify_token_exchange", base), 302)
  }

  return NextResponse.redirect(new URL("/onboarding", base), 302)
}
