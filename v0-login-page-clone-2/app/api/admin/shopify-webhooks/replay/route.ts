import { NextRequest, NextResponse } from "next/server"
import { ensureShopifySchema, query } from "@/lib/db"
import { processWebhookEvent } from "@/lib/shopify-sync"
import { log } from "@/lib/logger"

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV !== "production") {
    return NextResponse.json({ error: "Only available in production" }, { status: 403 })
  }
  const secret = req.headers.get("x-clean-db-secret") ?? ""
  if (!process.env.CLEAN_DB_SECRET || secret !== process.env.CLEAN_DB_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const limit = Math.min(100, Math.max(1, parseInt(req.nextUrl.searchParams.get("limit") ?? "25", 10) || 25))
  await ensureShopifySchema()
  const { rows } = await query<{
    user_id: string
    shop_domain: string
    topic: string
    event_id: string
    payload: Record<string, unknown>
  }>(
    `SELECT user_id, shop_domain, topic, event_id, payload
     FROM shopify_webhook_events
     WHERE status = 'failed'
     ORDER BY received_at DESC
     LIMIT $1`,
    [limit]
  )
  for (const row of rows) {
    await processWebhookEvent({
      userId: row.user_id,
      shopDomain: row.shop_domain,
      topic: row.topic,
      eventId: row.event_id,
      payload: row.payload ?? {},
    })
  }
  log("shopify.webhook.replay.done", { replayed: rows.length }, "shopify")
  return NextResponse.json({ ok: true, replayed: rows.length })
}
