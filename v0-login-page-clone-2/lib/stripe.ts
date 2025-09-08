/**
 * Stripe OAuth helpers for read-only Connect.
 *
 * Env:
 * - STRIPE_CLIENT_ID (required)
 * - STRIPE_SECRET_KEY (required – your platform secret)
 * - APP_URL or NEXT_PUBLIC_APP_URL (for redirect URI)
 */

import { log } from "./logger"

const STRIPE_AUTHORIZE_URL = "https://connect.stripe.com/oauth/authorize"
const STRIPE_TOKEN_URL = "https://connect.stripe.com/oauth/token"

export function getStripeClientId(): string {
  const clientId = process.env.STRIPE_CLIENT_ID ?? "ca_Tgsn0uJ2NT7ubkO7I4ELubpuzgy9IwyV"
  if (!clientId) {
    throw new Error("STRIPE_CLIENT_ID is not configured")
  }
  return clientId
}

export function getStripeRedirectUri(): string {
  const appUrl = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL
  if (!appUrl) {
    throw new Error("APP_URL or NEXT_PUBLIC_APP_URL must be set for Stripe OAuth")
  }
  return `${appUrl.replace(/\/$/, "")}/api/stripe/oauth/callback`
}

export function getStripeAuthorizeUrl(state: string): string {
  const clientId = getStripeClientId()
  const redirectUri = getStripeRedirectUri()
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    scope: "read_only",
    redirect_uri: redirectUri,
    state,
  })
  return `${STRIPE_AUTHORIZE_URL}?${params.toString()}`
}

export async function exchangeCodeForTokens(
  code: string
): Promise<{ accessToken: string; refreshToken?: string; scope?: string; stripeUserId: string }> {
  const clientSecret = process.env.STRIPE_SECRET_KEY
  if (!clientSecret) {
    throw new Error("STRIPE_SECRET_KEY is not configured")
  }
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    client_secret: clientSecret,
    code,
  })
  const res = await fetch(STRIPE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  })
  if (!res.ok) {
    const text = await res.text()
    log("stripe.oauth.token_exchange.failed", { status: res.status, body: text.slice(0, 500) }, "stripe")
    throw new Error(`Stripe token exchange failed: ${res.status}`)
  }
  const data = (await res.json()) as {
    access_token: string
    refresh_token?: string
    scope?: string
    stripe_user_id?: string
  }
  if (!data.access_token || !data.stripe_user_id) {
    throw new Error("Stripe token exchange response missing access_token or stripe_user_id")
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    scope: data.scope,
    stripeUserId: data.stripe_user_id,
  }
}

