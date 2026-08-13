import { NextRequest, NextResponse } from "next/server"
import { ensureXeroSchema, query } from "@/lib/db"
import { log } from "@/lib/logger"
import { runXeroSyncForUser, type XeroSyncResult } from "@/lib/xero-sync"

/**
 * POST /api/admin/sync-xero-all
 * Runs Xero sync for every user that has a Xero connection.
 * Auth: x-clean-db-secret header. Production only.
 */
export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV !== "production") {
    return NextResponse.json({ error: "Only available in production" }, { status: 403 })
  }
  const secret = req.headers.get("x-clean-db-secret") ?? ""
  const expected = process.env.CLEAN_DB_SECRET
  if (!expected || secret !== expected) {
    log("admin.sync-xero-all.unauthorized", undefined, "xero")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  await ensureXeroSchema()
  const { rows } = await query<{ user_id: string }>(
    "SELECT DISTINCT user_id FROM xero_connections WHERE user_id IS NOT NULL"
  )
  const userIds = rows.map((r) => r.user_id)
  if (userIds.length === 0) {
    log("admin.sync-xero-all.no_connections", undefined, "xero")
    return NextResponse.json({ ok: true, users: 0, results: {} })
  }

  const results: Record<string, XeroSyncResult> = {}
  for (const userId of userIds) {
    results[userId] = await runXeroSyncForUser(userId)
  }

  log("admin.sync-xero-all.done", { users: userIds.length, userIds }, "xero")
  return NextResponse.json({ ok: true, users: userIds.length, results })
}
