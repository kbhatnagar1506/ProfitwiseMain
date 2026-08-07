import crypto from "crypto"

export interface ShopifyTokenExchangeResponse {
  access_token: string
  scope?: string
}

const DEFAULT_REQUIRED_SCOPES = [
  "read_orders",
  "read_all_orders",
  "read_customers",
  "read_products",
  "read_inventory",
]

export function normalizeShopDomain(input: string): string {
  const raw = (input || "").trim().toLowerCase()
  const withoutProtocol = raw.replace(/^https?:\/\//, "")
  const host = withoutProtocol.split("/")[0] ?? ""
  const clean = host.replace(/\.$/, "")
  if (!clean || !clean.endsWith(".myshopify.com")) {
    throw new Error("Invalid Shopify shop domain")
  }
  return clean
}

export function getRequiredShopifyScopes(): string[] {
  const configured = process.env.SHOPIFY_REQUIRED_SCOPES
  if (!configured) return DEFAULT_REQUIRED_SCOPES
  return configured
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

function getClientId(): string {
  const value = process.env.SHOPIFY_CLIENT_ID
  if (!value) throw new Error("SHOPIFY_CLIENT_ID is not configured")
  return value
}

function getClientSecret(): string {
  const value = process.env.SHOPIFY_CLIENT_SECRET
  if (!value) throw new Error("SHOPIFY_CLIENT_SECRET is not configured")
  return value
}

export function getShopifyRedirectUri(origin: string): string {
  const configured = process.env.SHOPIFY_REDIRECT_URI
  if (configured) return configured
  const base = (process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? origin).replace(/\/$/, "")
  return `${base}/api/shopify/oauth/callback`
}

export function getShopifyAuthorizeUrl(params: {
  shopDomain: string
  state: string
  scopes?: string[]
  origin: string
}): string {
  const shop = normalizeShopDomain(params.shopDomain)
  const clientId = getClientId()
  const redirectUri = getShopifyRedirectUri(params.origin)
  const scopes = (params.scopes?.length ? params.scopes : getRequiredShopifyScopes()).join(",")
  const url = new URL(`https://${shop}/admin/oauth/authorize`)
  url.searchParams.set("client_id", clientId)
  url.searchParams.set("scope", scopes)
  url.searchParams.set("redirect_uri", redirectUri)
  url.searchParams.set("state", params.state)
  return url.toString()
}

export async function exchangeCodeForAccessToken(shopDomain: string, code: string): Promise<ShopifyTokenExchangeResponse> {
  const shop = normalizeShopDomain(shopDomain)
  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: getClientId(),
      client_secret: getClientSecret(),
      code,
    }),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`Shopify token exchange failed (${response.status}): ${text || "unknown error"}`)
  }
  const data = (await response.json()) as ShopifyTokenExchangeResponse
  if (!data.access_token) throw new Error("Shopify token exchange returned no access token")
  return data
}

export function parseScopeString(scope?: string): string[] {
  if (!scope) return []
  return scope
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

export function getMissingScopes(grantedScopes: string[], requiredScopes: string[] = getRequiredShopifyScopes()): string[] {
  const granted = new Set(grantedScopes)
  return requiredScopes.filter((scope) => !granted.has(scope))
}

export function verifyShopifyCallbackHmac(queryParams: URLSearchParams): boolean {
  const hmac = queryParams.get("hmac")
  if (!hmac) return false
  const secret = process.env.SHOPIFY_CLIENT_SECRET
  if (!secret) return false

  const grouped = new Map<string, string[]>()
  for (const [key, value] of queryParams.entries()) {
    if (key === "hmac" || key === "signature") continue
    const arr = grouped.get(key) ?? []
    arr.push(value)
    grouped.set(key, arr)
  }

  const message = Array.from(grouped.keys())
    .sort()
    .map((key) => `${key}=${(grouped.get(key) ?? []).join(",")}`)
    .join("&")

  const digest = crypto.createHmac("sha256", secret).update(message).digest("hex")
  const digestBuf = Buffer.from(digest, "utf8")
  const hmacBuf = Buffer.from(hmac, "utf8")
  if (digestBuf.length !== hmacBuf.length) return false
  return crypto.timingSafeEqual(digestBuf, hmacBuf)
}
