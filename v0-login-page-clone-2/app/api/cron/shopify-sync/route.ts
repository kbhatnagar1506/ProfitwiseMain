import { NextRequest, NextResponse } from "next/server"
import { runShopifySyncForAllConnections } from "@/lib/shopify-sync"
import { log } from "@/lib/logger"

/**
 * POST /api/cron/shopify-sync
 * Pull-based incremental sync for all connected Shopify shops (no webhooks required).
 * Auth: x-clean-db-secret header. Production only.
 */
export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV !== "production") {
    return NextResponse.json({ error: "Only available in production" }, { status: 403 })
  }
  const secret = req.headers.get("x-clean-db-secret") ?? ""
  const expected = process.env.CLEAN_DB_SECRET
  if (!expected || secret !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const result = await runShopifySyncForAllConnections()
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    log("cron.shopify-sync.failed", { error: message }, "shopify")
    return NextResponse.json({ error: "Sync failed", detail: message }, { status: 500 })
  }
}
