/**
 * Shopify OAuth and API helpers.
 * Env: SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, APP_URL (for redirect_uri).
 */

import crypto from "crypto"
import { log } from "./logger"
import { ensureShopifySchema, query } from "./db"

const DEFAULT_SCOPES = "read_orders,read_products,read_customers"

function getConfig() {
  const clientId = process.env.SHOPIFY_CLIENT_ID
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET
  const appUrl = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL
  const redirectUri = appUrl ? `${appUrl.replace(/\/$/, "")}/api/shopify/oauth/callback` : undefined
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Shopify not configured: SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, APP_URL required")
  }
  const scopes = process.env.SHOPIFY_SCOPES ?? DEFAULT_SCOPES
  return { clientId, clientSecret, redirectUri, scopes }
}

/** Normalize shop to myshopify.com domain. */
export function normalizeShop(shop: string): string {
  const s = shop.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0]
  if (!s) return ""
  return s.endsWith(".myshopify.com") ? s : `${s}.myshopify.com`
}

/** Build Shopify authorize URL for the given shop and state. */
export function getAuthUrl(shop: string, state: string): string {
  const { clientId, redirectUri, scopes } = getConfig()
  const params = new URLSearchParams({
    client_id: clientId,
    scope: scopes,
    redirect_uri: redirectUri,
    state,
  })
  return `https://${shop}/admin/oauth/authorize?${params.toString()}`
}

/** Verify HMAC from Shopify callback. Query params as Record; exclude hmac and compare. */
export function verifyHmac(params: Record<string, string>, clientSecret: string): boolean {
  const hmac = params.hmac
  if (!hmac) return false
  const sorted = Object.keys(params)
    .filter((k) => k !== "hmac")
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&")
  const computed = crypto.createHmac("sha256", clientSecret).update(sorted).digest("hex")
  return crypto.timingSafeEqual(Buffer.from(hmac, "hex"), Buffer.from(computed, "hex"))
}

/** Exchange authorization code for access token. */
export async function exchangeCodeForToken(shop: string, code: string): Promise<{ access_token: string; scope: string }> {
  const { clientId, clientSecret } = getConfig()
  const url = `https://${shop}/admin/oauth/access_token`
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
    }),
  })
  if (!res.ok) {
    log("shopify.token_exchange.failed", { shop, status: res.status }, "shopify")
    throw new Error(`Shopify token exchange failed: ${res.status}`)
  }
  const data = (await res.json()) as { access_token: string; scope?: string }
  return { access_token: data.access_token, scope: data.scope ?? "" }
}

/** Store connection and return. */
export async function storeConnection(userId: string, shop: string, accessToken: string, scope: string): Promise<void> {
  await ensureShopifySchema()
  await query(
    `INSERT INTO shopify_connections (user_id, shop, access_token, scope, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (user_id, shop) DO UPDATE SET
       access_token = EXCLUDED.access_token,
       scope = EXCLUDED.scope,
       updated_at = NOW()`,
    [userId, shop, accessToken, scope]
  )
  log("shopify.connection.stored", { shop, userId }, "shopify")
}

/** List shop domains connected for a user. */
export async function listShopsByUserId(userId: string): Promise<string[]> {
  await ensureShopifySchema()
  const { rows } = await query<{ shop: string }>(
    "SELECT shop FROM shopify_connections WHERE user_id = $1 ORDER BY updated_at DESC",
    [userId]
  )
  return rows.map((r) => r.shop)
}
