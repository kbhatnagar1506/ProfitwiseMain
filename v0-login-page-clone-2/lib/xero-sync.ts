/**
 * Shared Xero sync logic. Used by POST /api/xero/sync and by Xero OAuth callback (background sync after connect).
 */

import { log } from "./logger"
import {
  fetchXeroList,
  getValidAccessToken,
  XERO_ENTITY_PATHS,
} from "@/lib/xero"
import { upsertEntities } from "@/lib/xero-entity-store"
import { listTenantIdsByUserId } from "@/lib/xero-token-store"

export type XeroSyncResult = {
  tenants: number
  totalSynced: number
  byType: Record<string, number>
}

/**
 * Run full Xero sync for a user: fetch all entity types for each connected tenant
 * and upsert into xero_entities (and GCP when enabled). Updates unified_invoices for Invoice type.
 */
export async function runXeroSyncForUser(userId: string): Promise<XeroSyncResult> {
  const tenantIds = await listTenantIdsByUserId(userId)
  if (tenantIds.length === 0) {
    return { tenants: 0, totalSynced: 0, byType: {} }
  }

  log("xero.sync.started", { userId, tenantCount: tenantIds.length }, "xero")
  const byType: Record<string, number> = {}
  let totalSynced = 0

  for (const tenantId of tenantIds) {
    try {
      const accessToken = await getValidAccessToken(tenantId)
      for (const { type, path } of XERO_ENTITY_PATHS) {
        try {
          const items = await fetchXeroList<unknown>(accessToken, tenantId, path)
          const count = await upsertEntities(tenantId, type, items, { userId })
          byType[type] = (byType[type] ?? 0) + count
          totalSynced += count
        } catch (err) {
          log("xero.sync.entity.failed", { tenantId, type, error: err instanceof Error ? err.message : String(err) }, "xero")
        }
      }
    } catch (err) {
      log("xero.sync.tenant.failed", { tenantId, error: err instanceof Error ? err.message : String(err) }, "xero")
    }
  }

  log("xero.sync.completed", { userId, tenants: tenantIds.length, totalSynced, byType }, "xero")
  return { tenants: tenantIds.length, totalSynced, byType }
}
