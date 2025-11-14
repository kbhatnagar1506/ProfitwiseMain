import crypto from "crypto"

export const SHOPIFY_REQUIRED_SCOPES = [
  "read_orders",
  "read_all_orders",
  "read_customers",
  "read_discounts",
  "read_shopify_payments_payouts",
  "read_shopify_payments_disputes",
]

export const SHOPIFY_CONSENT_TYPE = "shopify_data_storage"
export const SHOPIFY_POLICY_VERSION = "v1"

export type ShopifyRetentionMode = "default" | "12m" | "24m" | "indefinite"

export function normalizeShopDomain(input: string): string {
  const trimmed = input.trim().toLowerCase()
  const noScheme = trimmed.replace(/^https?:\/\//, "")
  const hostOnly = noScheme.split("/")[0] ?? ""
  return hostOnly
}

export function isValidShopDomain(input: string): boolean {
  const domain = normalizeShopDomain(input)
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain)
}

export function buildShopifyAuthorizeUrl(params: {
  shopDomain: string
  clientId: string
  redirectUri: string
  state: string
  scopes?: string[]
}): string {
  const shop = normalizeShopDomain(params.shopDomain)
  const scope = (params.scopes ?? SHOPIFY_REQUIRED_SCOPES).join(",")
  const query = new URLSearchParams({
    client_id: params.clientId,
    scope,
    redirect_uri: params.redirectUri,
    state: params.state,
  })
  return `https://${shop}/admin/oauth/authorize?${query.toString()}`
}

export function parseGrantedScopes(scopes: string | null | undefined): string[] {
  if (!scopes) return []
  return Array.from(
    new Set(
      scopes
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    )
  ).sort()
}

export function diffScopes(required: string[], granted: string[]): string[] {
  const grantedSet = new Set(granted)
  return required.filter((s) => !grantedSet.has(s))
}

export function generateOAuthState(): string {
  return crypto.randomBytes(24).toString("hex")
}

export function resolveAppBase(originFromRequest?: string): string {
  const appUrl = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? originFromRequest ?? ""
  return appUrl.replace(/\/$/, "")
}

export function getShopifyCallbackUrl(originFromRequest?: string): string {
  return `${resolveAppBase(originFromRequest)}/api/shopify/oauth/callback`
}

export function isValidHmacFromSearchParams(url: URL, clientSecret: string): boolean {
  const hmac = url.searchParams.get("hmac")
  if (!hmac) return false
  const pairs: string[] = []
  for (const [key, value] of url.searchParams.entries()) {
    if (key === "hmac" || key === "signature") continue
    pairs.push(`${key}=${value}`)
  }
  pairs.sort()
  const message = pairs.join("&")
  const digest = crypto.createHmac("sha256", clientSecret).update(message).digest("hex")
  try {
    return crypto.timingSafeEqual(Buffer.from(digest, "utf8"), Buffer.from(hmac, "utf8"))
  } catch {
    return false
  }
}

export function isValidWebhookHmac(rawBody: string, receivedHmac: string | null, clientSecret: string): boolean {
  if (!receivedHmac) return false
  const digest = crypto.createHmac("sha256", clientSecret).update(rawBody, "utf8").digest("base64")
  try {
    return crypto.timingSafeEqual(Buffer.from(digest, "utf8"), Buffer.from(receivedHmac, "utf8"))
  } catch {
    return false
  }
}
