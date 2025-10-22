import { ensureShopifySchema, query } from "./db"
import { decryptSecret, encryptSecret } from "./shopify-crypto"
import { SHOPIFY_CONSENT_TYPE, SHOPIFY_POLICY_VERSION, type ShopifyRetentionMode } from "./shopify"

export type ShopifyConnectionStatus =
  | "pending"
  | "connected"
  | "scope_missing"
  | "reauth_required"
  | "uninstalled"
  | "error"
  | "disconnected"

export type ShopifyConnectionRecord = {
  shop_domain: string
  status: ShopifyConnectionStatus
  granted_scopes: string[]
  missing_scopes: string[]
  installed_at: Date | null
  disconnected_at: Date | null
  retention_mode: ShopifyRetentionMode
  updated_at: Date
  last_error: string | null
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production"
}

export async function saveOAuthState(input: {
  state: string
  userId: string
  shopDomain: string
  clientId: string
  clientSecret: string
  redirectUri: string
  expiresAt: Date
}): Promise<void> {
  if (!isProduction()) return
  await ensureShopifySchema()
  await query(
    `INSERT INTO shopify_oauth_states (state, user_id, shop_domain, client_id, client_secret_encrypted, redirect_uri, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.state,
      input.userId,
      input.shopDomain,
      input.clientId,
      encryptSecret(input.clientSecret),
      input.redirectUri,
      input.expiresAt,
    ]
  )
}

export async function consumeOAuthState(state: string): Promise<{
  userId: string
  shopDomain: string
  clientId: string
  clientSecret: string
  expiresAt: Date
} | null> {
  if (!isProduction()) return null
  await ensureShopifySchema()
  const { rows } = await query<{
    user_id: string
    shop_domain: string
    client_id: string
    client_secret_encrypted: string
    expires_at: Date
    used_at: Date | null
  }>(
    `SELECT user_id, shop_domain, client_id, client_secret_encrypted, expires_at, used_at
     FROM shopify_oauth_states
     WHERE state = $1`,
    [state]
  )
  const row = rows[0]
  if (!row) return null
  if (row.used_at) return null
  if (new Date(row.expires_at).getTime() < Date.now()) return null
  await query("UPDATE shopify_oauth_states SET used_at = NOW() WHERE state = $1", [state])
  return {
    userId: row.user_id,
    shopDomain: row.shop_domain,
    clientId: row.client_id,
    clientSecret: decryptSecret(row.client_secret_encrypted),
    expiresAt: row.expires_at,
  }
}

export async function recordConsent(input: {
  userId: string
  shopDomain: string
  retentionMode: ShopifyRetentionMode
  policyVersion?: string
}): Promise<void> {
  if (!isProduction()) return
  await ensureShopifySchema()
  await query(
    `INSERT INTO shopify_data_consents (user_id, shop_domain, consent_type, policy_version, retention_mode, accepted_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (user_id, shop_domain, consent_type, policy_version) DO UPDATE SET
       retention_mode = EXCLUDED.retention_mode,
       accepted_at = NOW()`,
    [input.userId, input.shopDomain, SHOPIFY_CONSENT_TYPE, input.policyVersion ?? SHOPIFY_POLICY_VERSION, input.retentionMode]
  )
}

export async function getLatestConsent(userId: string, shopDomain: string): Promise<{
  retention_mode: ShopifyRetentionMode
  accepted_at: Date
  policy_version: string
} | null> {
  if (!isProduction()) return null
  await ensureShopifySchema()
  const { rows } = await query<{ retention_mode: ShopifyRetentionMode; accepted_at: Date; policy_version: string }>(
    `SELECT retention_mode, accepted_at, policy_version
     FROM shopify_data_consents
     WHERE user_id = $1 AND shop_domain = $2 AND consent_type = $3
     ORDER BY accepted_at DESC
     LIMIT 1`,
    [userId, shopDomain, SHOPIFY_CONSENT_TYPE]
  )
  return rows[0] ?? null
}

export async function upsertConnectionFromOAuth(input: {
  userId: string
  shopDomain: string
  clientId: string
  accessToken: string
  grantedScopes: string[]
  missingScopes: string[]
  retentionMode: ShopifyRetentionMode
  status: ShopifyConnectionStatus
}): Promise<void> {
  if (!isProduction()) return
  await ensureShopifySchema()
  await query(
    `INSERT INTO shopify_connections (
       user_id, shop_domain, client_id, access_token_encrypted,
       granted_scopes, missing_scopes, status, retention_mode, installed_at, updated_at, temp_client_secret_encrypted, disconnected_at, last_error
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW(), NULL, NULL, NULL)
     ON CONFLICT (user_id, shop_domain) DO UPDATE SET
       client_id = EXCLUDED.client_id,
       access_token_encrypted = EXCLUDED.access_token_encrypted,
       granted_scopes = EXCLUDED.granted_scopes,
       missing_scopes = EXCLUDED.missing_scopes,
       status = EXCLUDED.status,
       retention_mode = EXCLUDED.retention_mode,
       installed_at = NOW(),
       updated_at = NOW(),
       temp_client_secret_encrypted = NULL,
       disconnected_at = NULL,
       last_error = NULL`,
    [
      input.userId,
      input.shopDomain,
      input.clientId,
      encryptSecret(input.accessToken),
      input.grantedScopes,
      input.missingScopes,
      input.status,
      input.retentionMode,
    ]
  )
}

export async function listConnectionsByUser(userId: string): Promise<ShopifyConnectionRecord[]> {
  if (!isProduction()) return []
  await ensureShopifySchema()
  const { rows } = await query<ShopifyConnectionRecord>(
    `SELECT shop_domain, status, granted_scopes, missing_scopes, installed_at, disconnected_at, retention_mode, updated_at, last_error
     FROM shopify_connections
     WHERE user_id = $1
     ORDER BY updated_at DESC`,
    [userId]
  )
  return rows
}

export async function getConnectionSecretForWebhook(shopDomain: string): Promise<string | null> {
  if (!isProduction()) return null
  await ensureShopifySchema()
  const { rows } = await query<{ access_token_encrypted: string | null }>(
    `SELECT access_token_encrypted
     FROM shopify_connections
     WHERE shop_domain = $1 AND status IN ('connected', 'scope_missing', 'reauth_required')
     ORDER BY updated_at DESC
     LIMIT 1`,
    [shopDomain]
  )
  const enc = rows[0]?.access_token_encrypted
  return enc ? decryptSecret(enc) : null
}

export async function disconnectConnection(input: {
  userId: string
  shopDomain: string
  purge: boolean
}): Promise<void> {
  if (!isProduction()) return
  await ensureShopifySchema()
  await query(
    `UPDATE shopify_connections
     SET status = 'disconnected',
         disconnected_at = NOW(),
         access_token_encrypted = NULL,
         temp_client_secret_encrypted = NULL,
         updated_at = NOW()
     WHERE user_id = $1 AND shop_domain = $2`,
    [input.userId, input.shopDomain]
  )
  if (!input.purge) return
  await query("DELETE FROM shopify_orders WHERE user_id = $1 AND shop_domain = $2", [input.userId, input.shopDomain])
  await query("DELETE FROM shopify_refunds WHERE user_id = $1 AND shop_domain = $2", [input.userId, input.shopDomain])
  await query("DELETE FROM shopify_payouts WHERE user_id = $1 AND shop_domain = $2", [input.userId, input.shopDomain])
  await query("DELETE FROM shopify_balance_transactions WHERE user_id = $1 AND shop_domain = $2", [input.userId, input.shopDomain])
}

export async function markConnectionStatus(input: {
  userId: string
  shopDomain: string
  status: ShopifyConnectionStatus
  lastError?: string | null
}): Promise<void> {
  if (!isProduction()) return
  await ensureShopifySchema()
  await query(
    `UPDATE shopify_connections
     SET status = $3, last_error = $4, updated_at = NOW()
     WHERE user_id = $1 AND shop_domain = $2`,
    [input.userId, input.shopDomain, input.status, input.lastError ?? null]
  )
}

export async function storeWebhookEvent(input: {
  userId: string
  shopDomain: string
  topic: string
  eventId: string
  payload: unknown
  headers: Record<string, string>
}): Promise<boolean> {
  if (!isProduction()) return false
  await ensureShopifySchema()
  try {
    await query(
      `INSERT INTO shopify_webhook_events (user_id, shop_domain, topic, event_id, payload, headers, status)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'received')`,
      [input.userId, input.shopDomain, input.topic, input.eventId, JSON.stringify(input.payload ?? {}), JSON.stringify(input.headers ?? {})]
    )
    return true
  } catch {
    return false
  }
}

export async function updateWebhookEventStatus(eventId: string, topic: string, shopDomain: string, status: "processing" | "processed" | "failed", errorMessage?: string): Promise<void> {
  if (!isProduction()) return
  await ensureShopifySchema()
  await query(
    `UPDATE shopify_webhook_events
     SET status = $4, error_message = $5, processed_at = CASE WHEN $4 IN ('processed','failed') THEN NOW() ELSE processed_at END
     WHERE event_id = $1 AND topic = $2 AND shop_domain = $3`,
    [eventId, topic, shopDomain, status, errorMessage ?? null]
  )
}

export async function enqueueSyncJob(input: {
  userId: string
  shopDomain: string
  jobType: "webhook" | "backfill"
  payload: Record<string, unknown>
}): Promise<void> {
  if (!isProduction()) return
  await ensureShopifySchema()
  await query(
    `INSERT INTO shopify_sync_jobs (user_id, shop_domain, job_type, payload, status, attempts, max_attempts, next_run_at)
     VALUES ($1, $2, $3, $4::jsonb, 'queued', 0, 5, NOW())`,
    [input.userId, input.shopDomain, input.jobType, JSON.stringify(input.payload)]
  )
}

export async function listFailedWebhookEvents(userId: string, limit = 50): Promise<Array<{ event_id: string; topic: string; shop_domain: string }>> {
  if (!isProduction()) return []
  await ensureShopifySchema()
  const { rows } = await query<Array<{ event_id: string; topic: string; shop_domain: string }>[number]>(
    `SELECT event_id, topic, shop_domain
     FROM shopify_webhook_events
     WHERE user_id = $1 AND status = 'failed'
     ORDER BY received_at DESC
     LIMIT $2`,
    [userId, limit]
  )
  return rows
}

export async function listShopDomainsByUserId(userId: string): Promise<string[]> {
  if (!isProduction()) return []
  await ensureShopifySchema()
  const { rows } = await query<{ shop_domain: string }>(
    `SELECT shop_domain FROM shopify_connections WHERE user_id = $1 AND status IN ('connected', 'scope_missing', 'reauth_required')`,
    [userId]
  )
  return rows.map((r) => r.shop_domain)
}

export async function resolveConnectionByShopDomain(shopDomain: string): Promise<{ user_id: string; shop_domain: string } | null> {
  if (!isProduction()) return null
  await ensureShopifySchema()
  const { rows } = await query<{ user_id: string; shop_domain: string }>(
    `SELECT user_id, shop_domain
     FROM shopify_connections
     WHERE shop_domain = $1 AND status IN ('connected', 'scope_missing', 'reauth_required')
     ORDER BY updated_at DESC
     LIMIT 1`,
    [shopDomain]
  )
  return rows[0] ?? null
}
