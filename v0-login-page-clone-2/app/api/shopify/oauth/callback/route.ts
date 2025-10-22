import { NextRequest, NextResponse } from "next/server"
import { diffScopes, isValidHmacFromSearchParams, parseGrantedScopes, resolveAppBase, SHOPIFY_REQUIRED_SCOPES } from "@/lib/shopify"
import { getLatestConsent, consumeOAuthState, upsertConnectionFromOAuth } from "@/lib/shopify-token-store"
import { error as logError, log } from "@/lib/logger"
import { queueInitialBackfill, registerWebhookSubscriptions } from "@/lib/shopify-sync"

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const state = searchParams.get("state") ?? ""
  const code = searchParams.get("code") ?? ""
  const errorParam = searchParams.get("error")
  const appBase = resolveAppBase(request.nextUrl.origin)

  if (errorParam) {
    return NextResponse.redirect(new URL(`/onboarding?error=shopify_${encodeURIComponent(errorParam)}`, appBase), 302)
  }
  if (!state || !code) {
    return NextResponse.redirect(new URL("/onboarding?error=shopify_missing_params", appBase), 302)
  }

  const oauthState = await consumeOAuthState(state)
  if (!oauthState) {
    return NextResponse.redirect(new URL("/onboarding?error=shopify_state_invalid", appBase), 302)
  }

  if (!isValidHmacFromSearchParams(new URL(request.url), oauthState.clientSecret)) {
    logError("shopify.oauth.callback.failed", new Error("hmac_mismatch"), "shopify")
    return NextResponse.redirect(new URL("/onboarding?error=shopify_hmac_mismatch", appBase), 302)
  }

  try {
    const tokenResponse = await fetch(`https://${oauthState.shopDomain}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: oauthState.clientId,
        client_secret: oauthState.clientSecret,
        code,
      }),
    })
    if (!tokenResponse.ok) {
      throw new Error(`token_exchange_failed_${tokenResponse.status}`)
    }
    const tokenData = (await tokenResponse.json()) as { access_token?: string; scope?: string }
    const accessToken = tokenData.access_token ?? ""
    if (!accessToken) throw new Error("missing_access_token")

    const grantedScopes = parseGrantedScopes(tokenData.scope)
    const missingScopes = diffScopes(SHOPIFY_REQUIRED_SCOPES, grantedScopes)
    const consent = await getLatestConsent(oauthState.userId, oauthState.shopDomain)
    if (!consent) {
      return NextResponse.redirect(new URL("/onboarding?error=shopify_consent_missing", appBase), 302)
    }

    await upsertConnectionFromOAuth({
      userId: oauthState.userId,
      shopDomain: oauthState.shopDomain,
      clientId: oauthState.clientId,
      accessToken,
      grantedScopes,
      missingScopes,
      retentionMode: consent.retention_mode,
      status: missingScopes.length ? "scope_missing" : "connected",
    })

    await registerWebhookSubscriptions(oauthState.userId, oauthState.shopDomain)
    await queueInitialBackfill(oauthState.userId, oauthState.shopDomain)

    log("shopify.oauth.callback.succeeded", { shopDomain: oauthState.shopDomain, missingScopes: missingScopes.length }, "shopify")
    return NextResponse.redirect(new URL(`/onboarding?shopify_connected=1&shop=${encodeURIComponent(oauthState.shopDomain)}`, appBase), 302)
  } catch (err) {
    logError("shopify.oauth.callback.failed", err, "shopify")
    return NextResponse.redirect(new URL("/onboarding?error=shopify_token_exchange", appBase), 302)
  }
}
