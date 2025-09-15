import { NextRequest, NextResponse } from "next/server"
import { ensureStripeSchema, query } from "@/lib/db"
import { log } from "@/lib/logger"
import { runStripeSyncForUser, type StripeSyncResult } from "@/lib/stripe-sync"

/**
 * POST /api/admin/sync-stripe-all
 * Runs Stripe sync for every user that has a Stripe connection.
 * Auth: x-clean-db-secret header. Production only.
 */
export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV !== "production") {
    return NextResponse.json({ error: "Only available in production" }, { status: 403 })
  }
  const secret = req.headers.get("x-clean-db-secret") ?? ""
  const expected = process.env.CLEAN_DB_SECRET
  if (!expected || secret !== expected) {
    log("admin.sync-stripe-all.unauthorized", undefined, "stripe")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  await ensureStripeSchema()
  const { rows } = await query<{ user_id: string }>(
    "SELECT DISTINCT user_id FROM stripe_connections WHERE user_id IS NOT NULL"
  )
  const userIds = rows.map((r) => r.user_id)
  if (userIds.length === 0) {
    log("admin.sync-stripe-all.no_connections", undefined, "stripe")
    return NextResponse.json({ ok: true, users: 0, results: {} })
  }

  const results: Record<string, StripeSyncResult> = {}
  for (const userId of userIds) {
    const { ok, results: userResults } = await runStripeSyncForUser(userId)
    if (ok) results[userId] = userResults
  }

  log("admin.sync-stripe-all.done", { users: userIds.length, userIds }, "stripe")
  return NextResponse.json({ ok: true, users: userIds.length, results })
}
