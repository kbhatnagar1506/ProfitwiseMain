import { NextRequest, NextResponse } from "next/server"
import { getPlaidWebhookLast } from "@/lib/db"

/** GET /api/admin/plaid-webhook-status — last Plaid webhook received_at. Production only; requires x-clean-db-secret header. */
export async function GET(req: NextRequest) {
  if (process.env.NODE_ENV !== "production") {
    return NextResponse.json({ error: "Only available in production" }, { status: 403 })
  }
  const secret = req.headers.get("x-clean-db-secret") ?? ""
  const expected = process.env.CLEAN_DB_SECRET
  if (!expected || secret !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const last = await getPlaidWebhookLast()
    if (!last) {
      return NextResponse.json({ last_received_at: null, webhook_type: null, webhook_code: null, item_id: null })
    }
    return NextResponse.json({
      last_received_at: last.received_at.toISOString(),
      webhook_type: last.webhook_type,
      webhook_code: last.webhook_code,
      item_id: last.item_id,
    })
  } catch {
    return NextResponse.json({ error: "Failed to read webhook status" }, { status: 500 })
  }
}
