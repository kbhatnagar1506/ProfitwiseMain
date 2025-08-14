/**
 * QBO entity store. GCP bucket when GCP_ENTITY_BUCKET is set; else Postgres in production; in-memory in dev.
 */

import { ensureQBOSchema, query } from "./db"
import { log } from "./logger"
import {
  isGcpEntityStoreEnabled,
  gcpUpsertEntities,
  gcpGetEntities,
  gcpDeleteEntity,
} from "./entity-store-gcp"

function getEntityId(item: unknown): string | null {
  if (item == null || typeof item !== "object") return null
  const id = (item as Record<string, unknown>).Id
  if (id == null) return null
  return String(id)
}

const memoryStore = new Map<string, Map<string, Map<string, unknown>>>()

function getRealmTypeMap(realmId: string, entityType: string): Map<string, unknown> {
  let byRealm = memoryStore.get(realmId)
  if (!byRealm) {
    byRealm = new Map()
    memoryStore.set(realmId, byRealm)
  }
  let byType = byRealm.get(entityType) as Map<string, unknown> | undefined
  if (!byType) {
    byType = new Map()
    byRealm.set(entityType, byType)
  }
  return byType
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production"
}

export async function upsertEntities(
  realmId: string,
  entityType: string,
  items: unknown[]
): Promise<number> {
  if (items.length === 0) return 0
  if (isGcpEntityStoreEnabled()) {
    try {
      return await gcpUpsertEntities("qbo", realmId, entityType, items, getEntityId)
    } catch (err) {
      log("entity_store.upsert.failed", { realmId, entityType, error: err instanceof Error ? err.message : String(err) }, "qbo")
      throw err
    }
  }
  if (isProduction()) {
    try {
      await ensureQBOSchema()
      let inserted = 0
      for (const item of items) {
        const entityId = getEntityId(item)
        if (!entityId) continue
        await query(
          `INSERT INTO qbo_entities (realm_id, entity_type, entity_id, data, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, NOW())
           ON CONFLICT (realm_id, entity_type, entity_id) DO UPDATE SET
             data = EXCLUDED.data,
             updated_at = NOW()`,
          [realmId, entityType, entityId, JSON.stringify(item)]
        )
        inserted++
      }
      if (inserted > 0) {
        log("entity_store.upsert.succeeded", { realmId, entityType, count: inserted }, "qbo")
      }
      return inserted
    } catch (err) {
      log("entity_store.upsert.failed", { realmId, entityType, error: err instanceof Error ? err.message : String(err) }, "qbo")
      throw err
    }
  }
  const typeMap = getRealmTypeMap(realmId, entityType)
  let inserted = 0
  for (const item of items) {
    const entityId = getEntityId(item)
    if (!entityId) continue
    typeMap.set(entityId, item)
    inserted++
  }
  if (inserted > 0) {
    log("entity_store.upsert.succeeded", { realmId, entityType, count: inserted }, "qbo")
  }
  return inserted
}

export async function deleteEntity(
  realmId: string,
  entityType: string,
  entityId: string
): Promise<boolean> {
  if (isGcpEntityStoreEnabled()) {
    try {
      return await gcpDeleteEntity("qbo", realmId, entityType, entityId, getEntityId)
    } catch (err) {
      log("entity_store.delete.failed", { realmId, entityType, entityId, error: String(err) }, "qbo")
      return false
    }
  }
  if (isProduction()) {
    try {
      await ensureQBOSchema()
      await query(
        "DELETE FROM qbo_entities WHERE realm_id = $1 AND entity_type = $2 AND entity_id = $3",
        [realmId, entityType, entityId]
      )
      log("entity_store.delete.succeeded", { realmId, entityType, entityId }, "qbo")
      return true
    } catch (err) {
      log("entity_store.delete.failed", { realmId, entityType, entityId, error: String(err) }, "qbo")
      return false
    }
  }
  const byRealm = memoryStore.get(realmId)
  if (!byRealm) return true
  const byType = byRealm.get(entityType) as Map<string, unknown> | undefined
  if (byType) byType.delete(entityId)
  log("entity_store.delete.succeeded", { realmId, entityType, entityId }, "qbo")
  return true
}

export async function getEntitiesFromDb(
  realmId: string,
  entityType?: string
): Promise<Record<string, unknown[]>> {
  if (isGcpEntityStoreEnabled()) {
    try {
      return await gcpGetEntities("qbo", realmId, entityType)
    } catch (err) {
      log("entity_store.read.failed", { realmId, error: err instanceof Error ? err.message : String(err) }, "qbo")
      return {}
    }
  }
  if (isProduction()) {
    try {
      await ensureQBOSchema()
      if (entityType) {
        const { rows } = await query<{ data: unknown }>(
          "SELECT data FROM qbo_entities WHERE realm_id = $1 AND entity_type = $2",
          [realmId, entityType]
        )
        const items = rows.map((r) => r.data)
        log("entity_store.read.succeeded", { realmId, entityType, count: items.length }, "qbo")
        return { [entityType]: items }
      }
      const { rows } = await query<{ entity_type: string; data: unknown }>(
        "SELECT entity_type, data FROM qbo_entities WHERE realm_id = $1",
        [realmId]
      )
      const out: Record<string, unknown[]> = {}
      for (const r of rows) {
        if (!out[r.entity_type]) out[r.entity_type] = []
        out[r.entity_type].push(r.data)
      }
      const total = rows.length
      log("entity_store.read.succeeded", { realmId, total }, "qbo")
      return out
    } catch (err) {
      log("entity_store.read.failed", { realmId, error: err instanceof Error ? err.message : String(err) }, "qbo")
      return {}
    }
  }
  const byRealm = memoryStore.get(realmId)
  if (!byRealm) return {}
  if (entityType) {
    const typeMap = byRealm.get(entityType) as Map<string, unknown> | undefined
    const items = typeMap ? Array.from(typeMap.values()) : []
    log("entity_store.read.succeeded", { realmId, entityType, count: items.length }, "qbo")
    return { [entityType]: items }
  }
  const out: Record<string, unknown[]> = {}
  for (const [type, typeMap] of byRealm) {
    out[type] = Array.from((typeMap as Map<string, unknown>).values())
  }
  const total = Object.values(out).reduce((s, arr) => s + arr.length, 0)
  log("entity_store.read.succeeded", { realmId, total }, "qbo")
  return out
}
