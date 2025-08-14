/**
 * Xero entity store. GCP bucket when GCP_ENTITY_BUCKET is set; else Postgres in production; in-memory in dev.
 */

import { ensureXeroSchema, query } from "./db"
import { log } from "./logger"
import {
  isGcpEntityStoreEnabled,
  gcpUpsertEntities,
  gcpGetEntities,
} from "./entity-store-gcp"

function getEntityId(item: unknown): string | null {
  if (item == null || typeof item !== "object") return null
  const o = item as Record<string, unknown>
  const id = o.InvoiceID ?? o.ContactID ?? o.AccountID ?? o.PaymentID ?? o.CreditNoteID ?? o.BankTransactionID ?? o.ManualJournalID ?? o.BillID ?? o.Id
  if (id == null) return null
  return String(id)
}

const memoryStore = new Map<string, Map<string, Map<string, unknown>>>()

function isProduction(): boolean {
  return process.env.NODE_ENV === "production"
}

function getTenantTypeMap(tenantId: string, entityType: string): Map<string, unknown> {
  let byTenant = memoryStore.get(tenantId)
  if (!byTenant) {
    byTenant = new Map()
    memoryStore.set(tenantId, byTenant)
  }
  let byType = byTenant.get(entityType) as Map<string, unknown> | undefined
  if (!byType) {
    byType = new Map()
    byTenant.set(entityType, byType)
  }
  return byType
}

export async function upsertEntities(
  tenantId: string,
  entityType: string,
  items: unknown[]
): Promise<number> {
  if (items.length === 0) return 0
  if (isGcpEntityStoreEnabled()) {
    try {
      return await gcpUpsertEntities("xero", tenantId, entityType, items, getEntityId)
    } catch (err) {
      log("entity_store.upsert.failed", { tenantId, entityType, error: err instanceof Error ? err.message : String(err) }, "xero")
      throw err
    }
  }
  if (isProduction()) {
    try {
      await ensureXeroSchema()
      let inserted = 0
      for (const item of items) {
        const entityId = getEntityId(item)
        if (!entityId) continue
        await query(
          `INSERT INTO xero_entities (tenant_id, entity_type, entity_id, data, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, NOW())
           ON CONFLICT (tenant_id, entity_type, entity_id) DO UPDATE SET
             data = EXCLUDED.data,
             updated_at = NOW()`,
          [tenantId, entityType, entityId, JSON.stringify(item)]
        )
        inserted++
      }
      if (inserted > 0) {
        log("entity_store.upsert.succeeded", { tenantId, entityType, count: inserted }, "xero")
      }
      return inserted
    } catch (err) {
      log("entity_store.upsert.failed", { tenantId, entityType, error: err instanceof Error ? err.message : String(err) }, "xero")
      throw err
    }
  }
  const typeMap = getTenantTypeMap(tenantId, entityType)
  let inserted = 0
  for (const item of items) {
    const entityId = getEntityId(item)
    if (!entityId) continue
    typeMap.set(entityId, item)
    inserted++
  }
  if (inserted > 0) {
    log("entity_store.upsert.succeeded", { tenantId, entityType, count: inserted }, "xero")
  }
  return inserted
}

export async function getEntitiesFromDb(
  tenantId: string,
  entityType?: string
): Promise<Record<string, unknown[]>> {
  if (isGcpEntityStoreEnabled()) {
    try {
      return await gcpGetEntities("xero", tenantId, entityType)
    } catch (err) {
      log("entity_store.read.failed", { tenantId, error: err instanceof Error ? err.message : String(err) }, "xero")
      return {}
    }
  }
  if (isProduction()) {
    try {
      await ensureXeroSchema()
      if (entityType) {
        const { rows } = await query<{ data: unknown }>(
          "SELECT data FROM xero_entities WHERE tenant_id = $1 AND entity_type = $2",
          [tenantId, entityType]
        )
        const items = rows.map((r) => r.data)
        log("entity_store.read.succeeded", { tenantId, entityType, count: items.length }, "xero")
        return { [entityType]: items }
      }
      const { rows } = await query<{ entity_type: string; data: unknown }>(
        "SELECT entity_type, data FROM xero_entities WHERE tenant_id = $1",
        [tenantId]
      )
      const out: Record<string, unknown[]> = {}
      for (const r of rows) {
        if (!out[r.entity_type]) out[r.entity_type] = []
        out[r.entity_type].push(r.data)
      }
      log("entity_store.read.succeeded", { tenantId, total: rows.length }, "xero")
      return out
    } catch (err) {
      log("entity_store.read.failed", { tenantId, error: err instanceof Error ? err.message : String(err) }, "xero")
      return {}
    }
  }
  const byTenant = memoryStore.get(tenantId)
  if (!byTenant) return {}
  if (entityType) {
    const typeMap = byTenant.get(entityType) as Map<string, unknown> | undefined
    const items = typeMap ? Array.from(typeMap.values()) : []
    log("entity_store.read.succeeded", { tenantId, entityType, count: items.length }, "xero")
    return { [entityType]: items }
  }
  const out: Record<string, unknown[]> = {}
  for (const [type, typeMap] of byTenant) {
    out[type] = Array.from((typeMap as Map<string, unknown>).values())
  }
  log("entity_store.read.succeeded", { tenantId, total: Object.values(out).reduce((s, a) => s + a.length, 0) }, "xero")
  return out
}
