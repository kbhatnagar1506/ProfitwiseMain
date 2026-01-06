import { NextRequest, NextResponse } from "next/server"
import { ensureGmailSchema, query } from "@/lib/db"
import { log } from "@/lib/logger"

/**
 * POST /api/admin/gmail-reset-processed
 * Resets processed_for_ap_ar = FALSE for recent messages so they can be re-extracted.
 * Query: ?days=7 (default) — reset messages synced in last N days.
 * Production only; requires x-clean-db-secret header.
 */
export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV !== "production") {
    return NextResponse.json({ error: "Only available in production" }, { status: 403 })
  }
  const secret = req.headers.get("x-clean-db-secret") ?? ""
  const expected = process.env.CLEAN_DB_SECRET
  if (!expected || secret !== expected) {
    log("admin.gmail-reset-processed.unauthorized", {}, "system")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const days = Math.min(30, Math.max(1, parseInt(req.nextUrl.searchParams.get("days") ?? "7", 10) || 7))

  try {
    await ensureGmailSchema()
    const { rows } = await query<{ message_id: string }>(
      `UPDATE gmail_synced_messages
       SET processed_for_ap_ar = FALSE
       WHERE synced_at > NOW() - ($1::text || ' days')::interval
       RETURNING message_id`,
      [days]
    )
    const count = rows.length
    log("admin.gmail-reset-processed.done", { count, days }, "gmail")
    return NextResponse.json({ ok: true, reset: count, days })
  } catch (err) {
    log("admin.gmail-reset-processed.failed", { error: String(err) }, "gmail")
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
