import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import {
  buildShopifyAuthorizeUrl,
  generateOAuthState,
  getShopifyCallbackUrl,
  isValidShopDomain,
  normalizeShopDomain,
  type ShopifyRetentionMode,
} from "@/lib/shopify"
import { getLatestConsent, recordConsent, saveOAuthState } from "@/lib/shopify-token-store"
import { log } from "@/lib/logger"
import { isShopifyOAuthEnabled } from "@/lib/shopify-flags"

type Body = {
  shop_domain?: string
  client_id?: string
  client_secret?: string
  retention_mode?: ShopifyRetentionMode
  accept_storage_consent?: boolean
}

export async function POST(request: NextRequest) {
  if (!isShopifyOAuthEnabled()) {
    return NextResponse.json({ error: "Shopify OAuth disabled" }, { status: 503 })
  }
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = (await request.json().catch(() => ({}))) as Body
  const shopDomain = normalizeShopDomain(body.shop_domain ?? "")
  const clientId = (body.client_id ?? "").trim()
  const clientSecret = (body.client_secret ?? "").trim()
  const retentionMode = body.retention_mode ?? "default"
  const accepted = body.accept_storage_consent === true

  if (!isValidShopDomain(shopDomain)) {
    return NextResponse.json({ error: "Invalid shop_domain", code: "invalid_shop_domain" }, { status: 400 })
  }
  if (!clientId || !clientSecret) {
    return NextResponse.json({ error: "Missing client_id or client_secret", code: "missing_credentials" }, { status: 400 })
  }

  const existingConsent = await getLatestConsent(user.id, shopDomain)
  if (!existingConsent && !accepted) {
    return NextResponse.json({ error: "Storage consent required", code: "consent_required" }, { status: 400 })
  }
  if (accepted) {
    await recordConsent({ userId: user.id, shopDomain, retentionMode })
  }

  const state = generateOAuthState()
  const callbackUrl = getShopifyCallbackUrl(request.nextUrl.origin)
  await saveOAuthState({
    state,
    userId: user.id,
    shopDomain,
    clientId,
    clientSecret,
    redirectUri: callbackUrl,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  })

  const authorizeUrl = buildShopifyAuthorizeUrl({
    shopDomain,
    clientId,
    redirectUri: callbackUrl,
    state,
  })

  log("shopify.oauth.authorize.created", { shopDomain }, "shopify")
  return NextResponse.json({ authorize_url: authorizeUrl })
}
