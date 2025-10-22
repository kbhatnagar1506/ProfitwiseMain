/**
 * Plaid item store. Uses Postgres in production (user-scoped); in-memory in dev.
 */

import { ensurePlaidSchema, query } from "./db"
import { log } from "./logger"

export type PlaidItemRow = {
  item_id: string
  access_token: string
  cursor: string | null
  created_at: Date
  updated_at: Date
}

const memoryStore = new Map<string, PlaidItemRow>()

function isProduction(): boolean {
  return process.env.NODE_ENV === "production"
}

export async function getPlaidItem(itemId: string): Promise<PlaidItemRow | null> {
  if (isProduction()) {
    try {
      await ensurePlaidSchema()
      const { rows } = await query<{ item_id: string; access_token: string; cursor: string | null; created_at: Date; updated_at: Date }>(
        "SELECT item_id, access_token, cursor, created_at, updated_at FROM plaid_items WHERE item_id = $1",
        [itemId]
      )
      const r = rows[0]
      if (!r) return null
      return { item_id: r.item_id, access_token: r.access_token, cursor: r.cursor, created_at: r.created_at, updated_at: r.updated_at }
    } catch {
      return null
    }
  }
  const row = memoryStore.get(itemId)
  return row ?? null
}

export async function upsertPlaidItem(
  itemId: string,
  accessToken: string,
  cursor?: string | null,
  userId?: string
): Promise<void> {
  const now = new Date()
  if (isProduction() && userId) {
    try {
      await ensurePlaidSchema()
      await query(
        `INSERT INTO plaid_items (user_id, item_id, access_token, cursor, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5)
         ON CONFLICT (item_id) DO UPDATE SET
           access_token = EXCLUDED.access_token,
           cursor = COALESCE(EXCLUDED.cursor, plaid_items.cursor),
           updated_at = EXCLUDED.updated_at`,
        [userId, itemId, accessToken, cursor ?? null, now]
      )
      log("plaid_item.upsert.succeeded", { itemId, userId }, "plaid")
      return
    } catch (err) {
      log("plaid_item.upsert.failed", { itemId, error: err instanceof Error ? err.message : String(err) }, "plaid")
      throw err
    }
  }
  const existing = memoryStore.get(itemId)
  memoryStore.set(itemId, {
    item_id: itemId,
    access_token: accessToken,
    cursor: cursor ?? existing?.cursor ?? null,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  })
}

export async function updatePlaidItemCursor(itemId: string, cursor: string): Promise<void> {
  if (isProduction()) {
    try {
      await ensurePlaidSchema()
      await query("UPDATE plaid_items SET cursor = $1, updated_at = NOW() WHERE item_id = $2", [cursor, itemId])
      return
    } catch (err) {
      log("plaid_item.cursor_update.failed", { itemId, error: err instanceof Error ? err.message : String(err) }, "plaid")
    }
  }
  const existing = memoryStore.get(itemId)
  if (existing) {
    memoryStore.set(itemId, { ...existing, cursor, updated_at: new Date() })
  }
}

/** Owner user id for a Plaid item (e.g. classify after sync). */
export async function getPlaidItemUserId(itemId: string): Promise<string | null> {
  try {
    await ensurePlaidSchema()
    const { rows } = await query<{ user_id: string }>(
      `SELECT user_id::text AS user_id FROM plaid_items WHERE item_id = $1`,
      [itemId],
    )
    return rows[0]?.user_id ?? null
  } catch {
    return null
  }
}

export async function listPlaidItemIds(userId?: string): Promise<string[]> {
  if (isProduction() && userId) {
    try {
      await ensurePlaidSchema()
      const { rows } = await query<{ item_id: string }>("SELECT item_id FROM plaid_items WHERE user_id = $1", [userId])
      return rows.map((r) => r.item_id)
    } catch {
      return []
    }
  }
  return Array.from(memoryStore.keys())
}
