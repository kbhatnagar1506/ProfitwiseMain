/**
 * Stripe token store. Postgres in production (user-scoped); in-memory in dev.
 */

import { ensureStripeSchema, query } from "./db"
import { log } from "./logger"

export interface StripeTokenPayload {
  accessToken: string
  refreshToken?: string
  scope?: string
}

const memoryStore = new Map<string, StripeTokenPayload>()

function isProduction(): boolean {
  return process.env.NODE_ENV === "production"
}

export async function getToken(stripeUserId: string): Promise<StripeTokenPayload | undefined> {
  if (isProduction()) {
    try {
      await ensureStripeSchema()
      const { rows } = await query<{
        access_token: string
        refresh_token: string | null
        scope: string | null
      }>("SELECT access_token, refresh_token, scope FROM stripe_connections WHERE stripe_user_id = $1", [stripeUserId])
      const r = rows[0]
      if (!r) return undefined
      return {
        accessToken: r.access_token,
        refreshToken: r.refresh_token ?? undefined,
        scope: r.scope ?? undefined,
      }
    } catch {
      return undefined
    }
  }
  return memoryStore.get(stripeUserId)
}

export async function setToken(
  stripeUserId: string,
  payload: StripeTokenPayload,
  options?: { userId?: string }
): Promise<void> {
  if (isProduction()) {
    try {
      await ensureStripeSchema()
      if (options?.userId) {
        await query(
          `INSERT INTO stripe_connections (user_id, stripe_user_id, access_token, refresh_token, scope, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
           ON CONFLICT (stripe_user_id) DO UPDATE SET
             user_id = EXCLUDED.user_id,
             access_token = EXCLUDED.access_token,
             refresh_token = EXCLUDED.refresh_token,
             scope = EXCLUDED.scope,
             updated_at = NOW()`,
          [
            options.userId,
            stripeUserId,
            payload.accessToken,
            payload.refreshToken ?? null,
            payload.scope ?? null,
          ]
        )
      } else {
        await query(
          `UPDATE stripe_connections SET access_token = $1, refresh_token = $2, scope = $3, updated_at = NOW()
           WHERE stripe_user_id = $4`,
          [payload.accessToken, payload.refreshToken ?? null, payload.scope ?? null, stripeUserId]
        )
      }
      log("stripe.token_store.set.succeeded", { stripeUserId }, "stripe")
      return
    } catch (err) {
      log("stripe.token_store.set.failed", { stripeUserId, error: err instanceof Error ? err.message : String(err) }, "stripe")
      throw err
    }
  }
  memoryStore.set(stripeUserId, payload)
  log("stripe.token_store.set.succeeded", { stripeUserId }, "stripe")
}

export async function listStripeAccountIdsByUserId(userId: string): Promise<string[]> {
  if (isProduction()) {
    try {
      await ensureStripeSchema()
      const { rows } = await query<{ stripe_user_id: string }>(
        "SELECT stripe_user_id FROM stripe_connections WHERE user_id = $1",
        [userId]
      )
      return rows.map((r) => r.stripe_user_id)
    } catch {
      return []
    }
  }
  return Array.from(memoryStore.keys())
}

