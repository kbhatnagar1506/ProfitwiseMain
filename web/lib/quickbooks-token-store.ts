/**
 * QBO token store. Postgres in production (user-scoped); in-memory in dev.
 */

import { ensureQBOSchema, query } from "./db"
import { log } from "./logger"

export interface QBOTokenPayload {
  refreshToken: string
  accessToken?: string
  expiresAt?: number
}

const memoryStore = new Map<string, QBOTokenPayload>()

function isProduction(): boolean {
  return process.env.NODE_ENV === "production"
}

export async function getToken(realmId: string): Promise<QBOTokenPayload | undefined> {
  if (isProduction()) {
    try {
      await ensureQBOSchema()
      const { rows } = await query<{ refresh_token: string; access_token: string | null; expires_at: Date | null }>(
        "SELECT refresh_token, access_token, expires_at FROM qbo_connections WHERE realm_id = $1",
        [realmId]
      )
      const r = rows[0]
      if (!r) return undefined
      const payload: QBOTokenPayload = {
        refreshToken: r.refresh_token,
        accessToken: r.access_token ?? undefined,
        expiresAt: r.expires_at ? new Date(r.expires_at).getTime() : undefined,
      }
      log("token_store.get.succeeded", { realmId, hit: true, source: "db" }, "qbo")
      return payload
    } catch {
      log("token_store.get.succeeded", { realmId, hit: false, source: "db" }, "qbo")
      return undefined
    }
  }
  const payload = memoryStore.get(realmId)
  log("token_store.get.succeeded", { realmId, hit: !!payload, source: "memory" }, "qbo")
  return payload
}

export async function setToken(
  realmId: string,
  payload: QBOTokenPayload,
  options?: { userId?: string; companyName?: string }
): Promise<void> {
  if (isProduction()) {
    try {
      await ensureQBOSchema()
      const expiresAt = payload.expiresAt != null ? new Date(payload.expiresAt) : null
      if (options?.userId) {
        await query(
          `INSERT INTO qbo_connections (user_id, realm_id, company_name, refresh_token, access_token, expires_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
           ON CONFLICT (realm_id) DO UPDATE SET
             user_id = EXCLUDED.user_id,
             company_name = COALESCE(EXCLUDED.company_name, qbo_connections.company_name),
             refresh_token = EXCLUDED.refresh_token,
             access_token = EXCLUDED.access_token,
             expires_at = EXCLUDED.expires_at,
             updated_at = NOW()`,
          [
            options.userId,
            realmId,
            options.companyName ?? null,
            payload.refreshToken,
            payload.accessToken ?? null,
            expiresAt,
          ]
        )
      } else {
        await query(
          `UPDATE qbo_connections SET refresh_token = $1, access_token = $2, expires_at = $3, updated_at = NOW() WHERE realm_id = $4`,
          [payload.refreshToken, payload.accessToken ?? null, expiresAt, realmId]
        )
      }
      log("token_store.set.succeeded", { realmId, source: "db" }, "qbo")
      return
    } catch (err) {
      log("token_store.set.failed", { realmId, error: err instanceof Error ? err.message : String(err) }, "qbo")
      throw err
    }
  }
  memoryStore.set(realmId, payload)
  log("token_store.set.succeeded", { realmId, source: "memory" }, "qbo")
}

export async function listRealmIdsByUserId(userId: string): Promise<string[]> {
  if (isProduction()) {
    try {
      await ensureQBOSchema()
      const { rows } = await query<{ realm_id: string }>("SELECT realm_id FROM qbo_connections WHERE user_id = $1", [userId])
      return rows.map((r) => r.realm_id)
    } catch {
      return []
    }
  }
  return Array.from(memoryStore.keys())
}
