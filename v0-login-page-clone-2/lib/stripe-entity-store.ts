/**
 * Stripe entity store. Postgres in production; in-memory in dev.
 */

import { ensureStripeSchema, query } from "./db"
import { log } from "./logger"
import { upsertUnifiedInvoices, deleteUnifiedInvoice } from "./unified-invoices"

function getEntityId(item: unknown): string | null {
  if (item == null || typeof item !== "object") return null
  const id = (item as Record<string, unknown>).id
  if (id == null) return null
  return String(id)
}

const memoryStore = new Map<string, Map<string, Map<string, unknown>>>()

function getAccountTypeMap(stripeAccountId: string, entityType: string): Map<string, unknown> {
  let byAccount = memoryStore.get(stripeAccountId)
  if (!byAccount) {
    byAccount = new Map()
    memoryStore.set(stripeAccountId, byAccount)
  }
  let byType = byAccount.get(entityType) as Map<string, unknown> | undefined
  if (!byType) {
    byType = new Map()
    byAccount.set(entityType, byType)
  }
  return byType
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production"
}

async function getUserIdByStripeAccountId(stripeAccountId: string): Promise<string | undefined> {
  try {
    await ensureStripeSchema()
    const { rows } = await query<{ user_id: string }>(
      "SELECT user_id FROM stripe_connections WHERE stripe_user_id = $1",
      [stripeAccountId]
    )
    return rows[0]?.user_id
  } catch {
    return undefined
  }
}

export async function upsertStripeEntities(
  stripeAccountId: string,
  entityType: string,
  items: unknown[],
  options?: { userId?: string }
): Promise<number> {
  if (items.length === 0) return 0
  let totalInserted = 0

  if (isProduction()) {
    try {
      await ensureStripeSchema()
      const userId = options?.userId ?? (await getUserIdByStripeAccountId(stripeAccountId))
      if (!userId) {
        log(
          "stripe.entity_store.upsert.skipped_no_user",
          { stripeAccountId, entityType },
          "stripe"
        )
        return 0
      }
      let inserted = 0
      for (const item of items) {
        const entityId = getEntityId(item)
        if (!entityId) continue
        await query(
          `INSERT INTO stripe_entities (user_id, stripe_account_id, entity_type, entity_id, data, updated_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
           ON CONFLICT (stripe_account_id, entity_type, entity_id) DO UPDATE SET
             user_id = EXCLUDED.user_id,
             data = EXCLUDED.data,
             updated_at = NOW()`,
          [userId, stripeAccountId, entityType, entityId, JSON.stringify(item)]
        )
        inserted++
      }
      if (inserted > 0) {
        log("stripe.entity_store.upsert.succeeded", {
          stripeAccountId,
          entityType,
          count: inserted,
        }, "stripe")
        if (entityType === "invoice") {
          await upsertUnifiedInvoices(userId, "stripe", stripeAccountId, items)
        }
      }
      totalInserted = Math.max(totalInserted, inserted)
      return totalInserted
    } catch (err) {
      log(
        "stripe.entity_store.upsert.failed",
        {
          stripeAccountId,
          entityType,
          error: err instanceof Error ? err.message : String(err),
        },
        "stripe"
      )
      throw err
    }
  }

  const typeMap = getAccountTypeMap(stripeAccountId, entityType)
  let inserted = 0
  for (const item of items) {
    const entityId = getEntityId(item)
    if (!entityId) continue
    typeMap.set(entityId, item)
    inserted++
  }
  if (inserted > 0) {
    log("stripe.entity_store.upsert.succeeded", {
      stripeAccountId,
      entityType,
      count: inserted,
    }, "stripe")
  }
  return inserted
}

export async function deleteStripeEntity(
  stripeAccountId: string,
  entityType: string,
  entityId: string
): Promise<boolean> {
  if (isProduction()) {
    try {
      await ensureStripeSchema()
      const { rows } = await query<{ entity_id: string }>(
        "DELETE FROM stripe_entities WHERE stripe_account_id = $1 AND entity_type = $2 AND entity_id = $3 RETURNING entity_id",
        [stripeAccountId, entityType, entityId]
      )
      const deleted = rows.length > 0
      if (deleted) {
        log("stripe.entity_store.delete.succeeded", { stripeAccountId, entityType, entityId }, "stripe")
        if (entityType === "invoice") {
          const userId = await getUserIdByStripeAccountId(stripeAccountId)
          if (userId) await deleteUnifiedInvoice(userId, "stripe", stripeAccountId, entityId)
        }
      }
      return deleted
    } catch (err) {
      log(
        "stripe.entity_store.delete.failed",
        { stripeAccountId, entityType, entityId, error: err instanceof Error ? err.message : String(err) },
        "stripe"
      )
      return false
    }
  }
  const byAccount = memoryStore.get(stripeAccountId)
  if (!byAccount) return false
  const typeMap = byAccount.get(entityType) as Map<string, unknown> | undefined
  if (!typeMap) return false
  const had = typeMap.delete(entityId)
  if (had) {
    log("stripe.entity_store.delete.succeeded", { stripeAccountId, entityType, entityId }, "stripe")
  }
  return had
}

export async function getStripeEntitiesFromDb(
  stripeAccountId: string,
  entityType?: string,
  options?: { userId?: string }
): Promise<Record<string, unknown[]>> {
  if (isProduction()) {
    try {
      await ensureStripeSchema()
      const userId = options?.userId ?? (await getUserIdByStripeAccountId(stripeAccountId))
      if (!userId) {
        return {}
      }
      if (entityType) {
        const { rows } = await query<{ data: unknown }>(
          "SELECT data FROM stripe_entities WHERE stripe_account_id = $1 AND entity_type = $2 AND user_id = $3",
          [stripeAccountId, entityType, userId]
        )
        const items = rows.map((r) => r.data)
        log(
          "stripe.entity_store.read.succeeded",
          { stripeAccountId, entityType, count: items.length },
          "stripe"
        )
        return { [entityType]: items }
      }
      const { rows } = await query<{ entity_type: string; data: unknown }>(
        "SELECT entity_type, data FROM stripe_entities WHERE stripe_account_id = $1 AND user_id = $2",
        [stripeAccountId, userId]
      )
      const out: Record<string, unknown[]> = {}
      for (const r of rows) {
        if (!out[r.entity_type]) out[r.entity_type] = []
        out[r.entity_type].push(r.data)
      }
      const total = rows.length
      log("stripe.entity_store.read.succeeded", { stripeAccountId, total }, "stripe")
      return out
    } catch (err) {
      log(
        "stripe.entity_store.read.failed",
        {
          stripeAccountId,
          entityType: entityType ?? null,
          error: err instanceof Error ? err.message : String(err),
        },
        "stripe"
      )
      return {}
    }
  }

  const byAccount = memoryStore.get(stripeAccountId)
  if (!byAccount) return {}
  if (entityType) {
    const typeMap = byAccount.get(entityType) as Map<string, unknown> | undefined
    const items = typeMap ? Array.from(typeMap.values()) : []
    log(
      "stripe.entity_store.read.succeeded",
      { stripeAccountId, entityType, count: items.length },
      "stripe"
    )
    return { [entityType]: items }
  }
  const out: Record<string, unknown[]> = {}
  for (const [type, typeMap] of byAccount) {
    out[type] = Array.from((typeMap as Map<string, unknown>).values())
  }
  const total = Object.values(out).reduce((s, arr) => s + arr.length, 0)
  log("stripe.entity_store.read.succeeded", { stripeAccountId, total }, "stripe")
  return out
}

