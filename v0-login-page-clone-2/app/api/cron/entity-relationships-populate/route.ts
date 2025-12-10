import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { populateEntityRelationships } from "@/lib/entity-relationship-detection"
import { log } from "@/lib/logger"

/**
 * POST /api/cron/entity-relationships-populate
 * Cron job to populate entity relationships for all users
 * Auth: x-clean-db-secret header
 */
export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV !== "production") {
    return NextResponse.json({ error: "Only available in production" }, { status: 403 })
  }

  const secret = req.headers.get("x-clean-db-secret") ?? ""
  const expected = process.env.CLEAN_DB_SECRET
  if (!expected || secret !== expected) {
    log("cron.entity_relationships_populate.unauthorized", undefined, "movements")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    // Get all users
    const { rows: users } = await query<{ id: string }>("SELECT id FROM users WHERE deleted_at IS NULL")

    const results: Record<string, unknown> = {}
    let totalProcessed = 0
    let totalErrors = 0

    for (const user of users) {
      try {
        const stats = await populateEntityRelationships(user.id)
        results[user.id] = stats
        totalProcessed++
      } catch (err) {
        log("cron.entity_relationships_populate.user_error", {
          userId: user.id,
          error: err instanceof Error ? err.message : String(err),
        })
        totalErrors++
      }
    }

    log("cron.entity_relationships_populate.complete", {
      total_users: users.length,
      processed: totalProcessed,
      errors: totalErrors,
    })

    return NextResponse.json({
      ok: true,
      total_users: users.length,
      processed: totalProcessed,
      errors: totalErrors,
      results,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log("cron.entity_relationships_populate.failed", { error: message }, "movements")
    return NextResponse.json({ error: "Cron job failed" }, { status: 500 })
  }
}
