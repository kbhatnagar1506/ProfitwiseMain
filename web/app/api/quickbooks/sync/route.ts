import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { ensureQBOSchema, query } from "@/lib/db"
import { getAllForEntity, ENTITY_TYPES, type QBOEntityType } from "@/lib/quickbooks"
import { upsertEntities } from "@/lib/qbo-entity-store"
import { log } from "@/lib/logger"
import { listRealmIdsByUserId } from "@/lib/quickbooks-token-store"

/**
 * POST /api/quickbooks/sync — full sync of all QBO data for a client (realm).
 * Body: { "realmId": "..." }. Stores every entity type in qbo_entities (the "bucket");
 * webhooks then keep it updated on top of this.
 */
export async function POST(request: NextRequest) {
  const token = request.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    log("qbo.sync.unauthorized", { reason: "no_session" }, "qbo")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let realmId: string | null = null
  try {
    const body = await request.json().catch(() => ({}))
    realmId = typeof (body as { realmId?: string }).realmId === "string" ? (body as { realmId: string }).realmId : null
  } catch {
    // no body
  }
  if (!realmId) {
    return NextResponse.json({ error: "realmId required in JSON body" }, { status: 400 })
  }

  const userRealmIds = await listRealmIdsByUserId(user.id)
  if (!userRealmIds.includes(realmId)) {
    log("qbo.sync.forbidden", { realmId, userId: user.id }, "qbo")
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  try {
    await ensureQBOSchema()
    await query(
      `INSERT INTO qbo_sync_status (realm_id, status, updated_at) VALUES ($1, 'syncing', NOW())
       ON CONFLICT (realm_id) DO UPDATE SET status = 'syncing', updated_at = NOW()`,
      [realmId]
    )
    log("qbo.sync.started", { realmId }, "qbo")
    const synced: Record<string, number> = {}
    for (const type of ENTITY_TYPES) {
      const items = await getAllForEntity(realmId, type as QBOEntityType)
      const count = await upsertEntities(realmId, type, items, { userId: user.id })
      synced[type] = count
    }
    const total = Object.values(synced).reduce((s, n) => s + n, 0)
    await query(
      `INSERT INTO qbo_sync_status (realm_id, last_full_sync_at, status, error_message, updated_at)
       VALUES ($1, NOW(), 'success', NULL, NOW())
       ON CONFLICT (realm_id) DO UPDATE SET last_full_sync_at = NOW(), status = 'success', error_message = NULL, updated_at = NOW()`,
      [realmId]
    )
    log("qbo.sync.succeeded", { realmId, total }, "qbo")
    return NextResponse.json({ ok: true, synced, total })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log("qbo.sync.failed", { realmId, error: message }, "qbo")
    try {
      await ensureQBOSchema()
      await query(
        `INSERT INTO qbo_sync_status (realm_id, status, error_message, updated_at) VALUES ($1, 'error', $2, NOW())
         ON CONFLICT (realm_id) DO UPDATE SET status = 'error', error_message = $2, updated_at = NOW()`,
        [realmId, message]
      )
    } catch {
      // ignore status update failure
    }
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
