import { NextRequest, NextResponse } from "next/server"
import { ensureShopifySchema, query } from "@/lib/db"
import { log } from "@/lib/logger"
import { isShopifySyncWorkerEnabled } from "@/lib/shopify-flags"

const MAX_BATCH = 25

export async function POST(req: NextRequest) {
  if (!isShopifySyncWorkerEnabled()) {
    return NextResponse.json({ error: "Shopify sync worker disabled" }, { status: 503 })
  }
  if (process.env.NODE_ENV !== "production") {
    return NextResponse.json({ error: "Only available in production" }, { status: 403 })
  }
  const secret = req.headers.get("x-clean-db-secret") ?? ""
  if (!process.env.CLEAN_DB_SECRET || secret !== process.env.CLEAN_DB_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  await ensureShopifySchema()
  const { rows } = await query<{
    id: string
    attempts: number
    max_attempts: number
    job_type: "webhook" | "backfill"
    user_id: string
    shop_domain: string
  }>(
    `SELECT id, attempts, max_attempts, job_type, user_id, shop_domain
     FROM shopify_sync_jobs
     WHERE status IN ('queued', 'failed') AND next_run_at <= NOW()
     ORDER BY next_run_at ASC
     LIMIT $1`,
    [MAX_BATCH]
  )

  let processed = 0
  let deadLettered = 0
  for (const job of rows) {
    try {
      await query("UPDATE shopify_sync_jobs SET status = 'processing', updated_at = NOW() WHERE id = $1", [job.id])
      // Placeholder processor: event-specific processing is handled at webhook intake.
      await query("UPDATE shopify_sync_jobs SET status = 'done', updated_at = NOW() WHERE id = $1", [job.id])
      processed++
    } catch {
      const attempts = job.attempts + 1
      const dead = attempts >= job.max_attempts
      await query(
        `UPDATE shopify_sync_jobs
         SET status = $2,
             attempts = $3,
             next_run_at = NOW() + (($3 * 10)::text || ' seconds')::interval,
             updated_at = NOW()
         WHERE id = $1`,
        [job.id, dead ? "dead_letter" : "failed", attempts]
      )
      if (dead) deadLettered++
    }
  }

  log("shopify.cron.sync.done", { processed, deadLettered }, "shopify")
  return NextResponse.json({ ok: true, processed, deadLettered })
}
