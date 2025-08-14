/**
 * Xero token store. Postgres in production (user-scoped); in-memory in dev.
 */

import { ensureXeroSchema, query } from "./db"
import { log } from "./logger"

export interface XeroTokenPayload {
  refreshToken: string
  accessToken?: string
  expiresAt?: number
}

const memoryStore = new Map<string, XeroTokenPayload>()

function isProduction(): boolean {
  return process.env.NODE_ENV === "production"
}

export async function getToken(tenantId: string): Promise<XeroTokenPayload | undefined> {
  if (isProduction()) {
    try {
      await ensureXeroSchema()
      const { rows } = await query<{ refresh_token: string; access_token: string | null; expires_at: Date | null }>(
        "SELECT refresh_token, access_token, expires_at FROM xero_connections WHERE tenant_id = $1",
        [tenantId]
      )
      const r = rows[0]
      if (!r) return undefined
      return {
        refreshToken: r.refresh_token,
        accessToken: r.access_token ?? undefined,
        expiresAt: r.expires_at ? new Date(r.expires_at).getTime() : undefined,
      }
    } catch {
      return undefined
    }
  }
  return memoryStore.get(tenantId)
}

export async function setToken(
  tenantId: string,
  payload: XeroTokenPayload,
  options?: { userId?: string; tenantName?: string }
): Promise<void> {
  if (isProduction()) {
    try {
      await ensureXeroSchema()
      const expiresAt = payload.expiresAt != null ? new Date(payload.expiresAt) : null
      if (options?.userId) {
        await query(
          `INSERT INTO xero_connections (user_id, tenant_id, tenant_name, refresh_token, access_token, expires_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
           ON CONFLICT (tenant_id) DO UPDATE SET
             user_id = EXCLUDED.user_id,
             tenant_name = EXCLUDED.tenant_name,
             refresh_token = EXCLUDED.refresh_token,
             access_token = EXCLUDED.access_token,
             expires_at = EXCLUDED.expires_at,
             updated_at = NOW()`,
          [
            options.userId,
            tenantId,
            options.tenantName ?? null,
            payload.refreshToken,
            payload.accessToken ?? null,
            expiresAt,
          ]
        )
      } else {
        await query(
          `UPDATE xero_connections SET refresh_token = $1, access_token = $2, expires_at = $3, updated_at = NOW() WHERE tenant_id = $4`,
          [payload.refreshToken, payload.accessToken ?? null, expiresAt, tenantId]
        )
      }
      log("token_store.set.succeeded", { tenantId }, "xero")
      return
    } catch (err) {
      log("token_store.set.failed", { tenantId, error: err instanceof Error ? err.message : String(err) }, "xero")
      throw err
    }
  }
  memoryStore.set(tenantId, payload)
  log("token_store.set.succeeded", { tenantId }, "xero")
}

export async function listTenantIdsByUserId(userId: string): Promise<string[]> {
  if (isProduction()) {
    try {
      await ensureXeroSchema()
      const { rows } = await query<{ tenant_id: string }>("SELECT tenant_id FROM xero_connections WHERE user_id = $1", [userId])
      return rows.map((r) => r.tenant_id)
    } catch {
      return []
    }
  }
  return Array.from(memoryStore.keys())
}
