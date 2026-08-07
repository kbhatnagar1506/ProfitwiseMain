import { NextRequest, NextResponse } from "next/server"
import { after } from "next/server"
import { ensureQBOSchema, query } from "@/lib/db"
import { getAllForEntity, ENTITY_TYPES, type QBOEntityType } from "@/lib/quickbooks"
import { upsertEntities } from "@/lib/qbo-entity-store"
import { log } from "@/lib/logger"

export const maxDuration = 300

async function runQboSyncForRealm(realm_id: string, user_id: string): Promise<void> {
  await ensureQBOSchema()
  await query(
    `INSERT INTO qbo_sync_status (realm_id, status, updated_at) VALUES ($1, 'syncing', NOW())
     ON CONFLICT (realm_id) DO UPDATE SET status = 'syncing', updated_at = NOW()`,
    [realm_id]
  )
  log("admin.sync-qbo-all.started", { realmId: realm_id, userId: user_id }, "qbo")
  try {
    const synced: Record<string, number> = {}
    for (const type of ENTITY_TYPES) {
      const items = await getAllForEntity(realm_id, type as QBOEntityType)
      const count = await upsertEntities(realm_id, type, items, { userId: user_id })
      synced[type] = count
    }
    const total = Object.values(synced).reduce((s, n) => s + n, 0)
    await query(
      `INSERT INTO qbo_sync_status (realm_id, last_full_sync_at, status, error_message, updated_at)
       VALUES ($1, NOW(), 'success', NULL, NOW())
       ON CONFLICT (realm_id) DO UPDATE SET last_full_sync_at = NOW(), status = 'success', error_message = NULL, updated_at = NOW()`,
      [realm_id]
    )
    log("admin.sync-qbo-all.realm_done", { realmId: realm_id, total }, "qbo")
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log("admin.sync-qbo-all.realm_failed", { realmId: realm_id, error: message }, "qbo")
    await query(
      `INSERT INTO qbo_sync_status (realm_id, status, error_message, updated_at) VALUES ($1, 'error', $2, NOW())
       ON CONFLICT (realm_id) DO UPDATE SET status = 'error', error_message = $2, updated_at = NOW()`,
      [realm_id, message]
    ).catch(() => {})
  }
}

/**
 * POST /api/admin/sync-qbo-all
 * Starts QBO sync for every user that has a QBO connection (each realm).
 * Returns immediately; sync runs in background to avoid timeout.
 * Auth: x-clean-db-secret header. Production only.
 */
export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV !== "production") {
    return NextResponse.json({ error: "Only available in production" }, { status: 403 })
  }
  const secret = req.headers.get("x-clean-db-secret") ?? ""
  const expected = process.env.CLEAN_DB_SECRET
  if (!expected || secret !== expected) {
    log("admin.sync-qbo-all.unauthorized", undefined, "qbo")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  await ensureQBOSchema()
  const { rows } = await query<{ realm_id: string; user_id: string }>(
    "SELECT realm_id, user_id FROM qbo_connections WHERE user_id IS NOT NULL"
  )
  if (rows.length === 0) {
    log("admin.sync-qbo-all.no_connections", undefined, "qbo")
    return NextResponse.json({ ok: true, realms: 0, message: "No QBO connections" })
  }

  const realmsToSync = rows.map((r) => ({ realm_id: r.realm_id, user_id: r.user_id }))
  after(async () => {
    for (const { realm_id, user_id } of realmsToSync) {
      try {
        await runQboSyncForRealm(realm_id, user_id)
      } catch (e) {
        log("admin.sync-qbo-all.after_error", { realmId: realm_id, error: String(e) }, "qbo")
      }
    }
  })

  log("admin.sync-qbo-all.queued", { realms: rows.length, realmIds: rows.map((r) => r.realm_id) }, "qbo")
  return NextResponse.json({
    ok: true,
    realms: rows.length,
    message: "QBO sync started in background", 
    realmIds: rows.map((r) => r.realm_id),
  })
}
