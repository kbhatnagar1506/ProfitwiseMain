import { NextRequest, NextResponse } from "next/server"
import { ensureShopifySchema, query } from "@/lib/db"

export async function GET(req: NextRequest) {
  if (process.env.NODE_ENV !== "production") {
    return NextResponse.json({ error: "Only available in production" }, { status: 403 })
  }
  const secret = req.headers.get("x-clean-db-secret") ?? ""
  if (!process.env.CLEAN_DB_SECRET || secret !== process.env.CLEAN_DB_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  await ensureShopifySchema()
  const [connections, failedWebhooks, deadLetterJobs] = await Promise.all([
    query<{ count: string }>("SELECT COUNT(*)::text as count FROM shopify_connections"),
    query<{ count: string }>("SELECT COUNT(*)::text as count FROM shopify_webhook_events WHERE status = 'failed'"),
    query<{ count: string }>("SELECT COUNT(*)::text as count FROM shopify_sync_jobs WHERE status = 'dead_letter'"),
  ])
  return NextResponse.json({
    connections: Number(connections.rows[0]?.count ?? 0),
    failed_webhooks: Number(failedWebhooks.rows[0]?.count ?? 0),
    dead_letter_jobs: Number(deadLetterJobs.rows[0]?.count ?? 0),
  })
}
