import { ensureShopifySchema, query } from "./db"
import { log } from "./logger"

export interface ShopifyConnectionPayload {
  accessToken: string
  scope?: string
  grantedScopes: string[]
  missingScopes: string[]
}

export interface ShopifyConnectionRecord {
  shopDomain: string
  scope?: string
  grantedScopes: string[]
  missingScopes: string[]
  updatedAt?: string
}

export interface ShopifyConnectionWithToken extends ShopifyConnectionRecord {
  userId: string
  accessToken: string
}

type MemoryValue = ShopifyConnectionPayload & { userId: string; shopDomain: string; updatedAt: string }

const memoryStore = new Map<string, MemoryValue>()

function isProduction(): boolean {
  return process.env.NODE_ENV === "production"
}

function key(userId: string, shopDomain: string): string {
  return `${userId}:${shopDomain}`
}

export async function setShopifyConnection(
  userId: string,
  shopDomain: string,
  payload: ShopifyConnectionPayload
): Promise<void> {
  if (isProduction()) {
    await ensureShopifySchema()
    await query(
      `INSERT INTO shopify_connections (user_id, shop_domain, access_token, scope, granted_scopes, missing_scopes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
       ON CONFLICT (user_id, shop_domain) DO UPDATE SET
         access_token = EXCLUDED.access_token,
         scope = EXCLUDED.scope,
         granted_scopes = EXCLUDED.granted_scopes,
         missing_scopes = EXCLUDED.missing_scopes,
         updated_at = NOW()`,
      [
        userId,
        shopDomain,
        payload.accessToken,
        payload.scope ?? null,
        payload.grantedScopes,
        payload.missingScopes,
      ]
    )
    log("shopify.token_store.set.succeeded", { userId, shopDomain }, "shopify")
    return
  }

  memoryStore.set(key(userId, shopDomain), {
    userId,
    shopDomain,
    accessToken: payload.accessToken,
    scope: payload.scope,
    grantedScopes: payload.grantedScopes,
    missingScopes: payload.missingScopes,
    updatedAt: new Date().toISOString(),
  })
  log("shopify.token_store.set.succeeded", { userId, shopDomain }, "shopify")
}

export async function getShopifyConnection(userId: string, shopDomain: string): Promise<ShopifyConnectionRecord | undefined> {
  if (isProduction()) {
    await ensureShopifySchema()
    const { rows } = await query<{
      shop_domain: string
      scope: string | null
      granted_scopes: string[] | null
      missing_scopes: string[] | null
      updated_at: Date | null
    }>(
      `SELECT shop_domain, scope, granted_scopes, missing_scopes, updated_at
       FROM shopify_connections
       WHERE user_id = $1 AND shop_domain = $2`,
      [userId, shopDomain]
    )
    const row = rows[0]
    if (!row) return undefined
    return {
      shopDomain: row.shop_domain,
      scope: row.scope ?? undefined,
      grantedScopes: row.granted_scopes ?? [],
      missingScopes: row.missing_scopes ?? [],
      updatedAt: row.updated_at ? row.updated_at.toISOString() : undefined,
    }
  }

  const row = memoryStore.get(key(userId, shopDomain))
  if (!row) return undefined
  return {
    shopDomain: row.shopDomain,
    scope: row.scope,
    grantedScopes: row.grantedScopes,
    missingScopes: row.missingScopes,
    updatedAt: row.updatedAt,
  }
}

export async function getShopifyConnectionWithToken(
  userId: string,
  shopDomain: string
): Promise<ShopifyConnectionWithToken | undefined> {
  if (isProduction()) {
    await ensureShopifySchema()
    const { rows } = await query<{
      user_id: string
      shop_domain: string
      access_token: string
      scope: string | null
      granted_scopes: string[] | null
      missing_scopes: string[] | null
      updated_at: Date | null
    }>(
      `SELECT user_id, shop_domain, access_token, scope, granted_scopes, missing_scopes, updated_at
       FROM shopify_connections
       WHERE user_id = $1 AND shop_domain = $2`,
      [userId, shopDomain]
    )
    const row = rows[0]
    if (!row) return undefined
    return {
      userId: row.user_id,
      shopDomain: row.shop_domain,
      accessToken: row.access_token,
      scope: row.scope ?? undefined,
      grantedScopes: row.granted_scopes ?? [],
      missingScopes: row.missing_scopes ?? [],
      updatedAt: row.updated_at ? row.updated_at.toISOString() : undefined,
    }
  }

  const row = memoryStore.get(key(userId, shopDomain))
  if (!row) return undefined
  return {
    userId: row.userId,
    shopDomain: row.shopDomain,
    accessToken: row.accessToken,
    scope: row.scope,
    grantedScopes: row.grantedScopes,
    missingScopes: row.missingScopes,
    updatedAt: row.updatedAt,
  }
}

export async function listShopifyShopDomainsByUserId(userId: string): Promise<string[]> {
  if (isProduction()) {
    await ensureShopifySchema()
    const { rows } = await query<{ shop_domain: string }>(
      "SELECT shop_domain FROM shopify_connections WHERE user_id = $1 ORDER BY updated_at DESC",
      [userId]
    )
    return rows.map((r) => r.shop_domain)
  }

  const domains: string[] = []
  for (const value of memoryStore.values()) {
    if (value.userId === userId) domains.push(value.shopDomain)
  }
  return domains
}

export async function listShopifyConnectionsByUserId(userId: string): Promise<ShopifyConnectionRecord[]> {
  if (isProduction()) {
    await ensureShopifySchema()
    const { rows } = await query<{
      shop_domain: string
      scope: string | null
      granted_scopes: string[] | null
      missing_scopes: string[] | null
      updated_at: Date | null
    }>(
      `SELECT shop_domain, scope, granted_scopes, missing_scopes, updated_at
       FROM shopify_connections
       WHERE user_id = $1
       ORDER BY updated_at DESC`,
      [userId]
    )
    return rows.map((row) => ({
      shopDomain: row.shop_domain,
      scope: row.scope ?? undefined,
      grantedScopes: row.granted_scopes ?? [],
      missingScopes: row.missing_scopes ?? [],
      updatedAt: row.updated_at ? row.updated_at.toISOString() : undefined,
    }))
  }

  return Array.from(memoryStore.values())
    .filter((v) => v.userId === userId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((v) => ({
      shopDomain: v.shopDomain,
      scope: v.scope,
      grantedScopes: v.grantedScopes,
      missingScopes: v.missingScopes,
      updatedAt: v.updatedAt,
    }))
}

export async function listAllShopifyConnectionsWithToken(): Promise<ShopifyConnectionWithToken[]> {
  if (isProduction()) {
    await ensureShopifySchema()
    const { rows } = await query<{
      user_id: string
      shop_domain: string
      access_token: string
      scope: string | null
      granted_scopes: string[] | null
      missing_scopes: string[] | null
      updated_at: Date | null
    }>(
      `SELECT user_id, shop_domain, access_token, scope, granted_scopes, missing_scopes, updated_at
       FROM shopify_connections
       ORDER BY updated_at DESC`
    )
    return rows.map((row) => ({
      userId: row.user_id,
      shopDomain: row.shop_domain,
      accessToken: row.access_token,
      scope: row.scope ?? undefined,
      grantedScopes: row.granted_scopes ?? [],
      missingScopes: row.missing_scopes ?? [],
      updatedAt: row.updated_at ? row.updated_at.toISOString() : undefined,
    }))
  }

  return Array.from(memoryStore.values()).map((v) => ({
    userId: v.userId,
    shopDomain: v.shopDomain,
    accessToken: v.accessToken,
    scope: v.scope,
    grantedScopes: v.grantedScopes,
    missingScopes: v.missingScopes,
    updatedAt: v.updatedAt,
  }))
}
