import { NextRequest, NextResponse } from "next/server"
import { ensureStripeSchema, query } from "@/lib/db"
import { log } from "@/lib/logger"

/**
 * POST /api/admin/clear-stripe
 * Removes all Stripe connections and entities (all users) for testing.
 * Auth: x-clean-db-secret header. Production only.
 */
export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV !== "production") {
    return NextResponse.json({ error: "Only available in production" }, { status: 403 })
  }
  const secret = req.headers.get("x-clean-db-secret") ?? ""
  const expected = process.env.CLEAN_DB_SECRET
  if (!expected || secret !== expected) {
    log("admin.clear-stripe.unauthorized", undefined, "stripe")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  await ensureStripeSchema()
  await query("DELETE FROM stripe_entities")
  const conn = await query<{ id: string }>("DELETE FROM stripe_connections RETURNING id")
  const connectionsDeleted = conn.rows.length
  log("admin.clear-stripe.done", { connectionsDeleted }, "stripe")
  return NextResponse.json({ ok: true, stripe_connections_deleted: connectionsDeleted })
}
