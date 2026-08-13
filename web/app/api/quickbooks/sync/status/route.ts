import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { ensureQBOSchema, query } from "@/lib/db"
import { log } from "@/lib/logger"
import { listRealmIdsByUserId } from "@/lib/quickbooks-token-store"

/**
 * GET /api/quickbooks/sync/status?realmId=... — sync status for a QBO realm (last full sync, status, error).
 */
export async function GET(request: NextRequest) {
  const token = request.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    log("qbo.sync_status.unauthorized", { reason: "no_session" }, "qbo")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const realmId = request.nextUrl.searchParams.get("realmId")
  const userRealmIds = await listRealmIdsByUserId(user.id)
  if (realmId && !userRealmIds.includes(realmId)) {
    log("qbo.sync_status.forbidden", { realmId, userId: user.id }, "qbo")
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  try {
    await ensureQBOSchema()
    const realmIdsToFetch = realmId ? [realmId] : userRealmIds
    if (realmIdsToFetch.length === 0) {
      return NextResponse.json(realmId ? { realmId, lastFullSyncAt: null, status: "idle", errorMessage: null, updatedAt: null } : { statuses: [] })
    }
    const { rows } = await query<{
      realm_id: string
      last_full_sync_at: Date | null
      status: string
      error_message: string | null
      updated_at: Date
    }>(
      "SELECT realm_id, last_full_sync_at, status, error_message, updated_at FROM qbo_sync_status WHERE realm_id = ANY($1::text[])",
      [realmIdsToFetch]
    )
    const byRealm = new Map(rows.map((r) => [r.realm_id, r]))
    const toPayload = (r: typeof rows[0] | undefined, rid: string) => ({
      realmId: rid,
      lastFullSyncAt: r?.last_full_sync_at?.toISOString() ?? null,
      status: r?.status ?? "idle",
      errorMessage: r?.error_message ?? null,
      updatedAt: r?.updated_at?.toISOString() ?? null,
    })
    if (realmId) {
      return NextResponse.json(toPayload(byRealm.get(realmId), realmId))
    }
    const statuses = realmIdsToFetch.map((rid) => toPayload(byRealm.get(rid), rid))
    return NextResponse.json({ statuses })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log("qbo.sync_status.failed", { realmId: realmId ?? "all", error: message }, "qbo")
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
