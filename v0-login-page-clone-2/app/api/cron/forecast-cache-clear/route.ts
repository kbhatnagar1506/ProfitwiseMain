import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { log } from "@/lib/log"

/**
 * POST /api/cron/forecast-cache-clear
 * Clear forecast cache for all users (cron job)
 */
export async function POST(request: NextRequest) {
  try {
    const secret = request.headers.get("x-clean-db-secret")
    const expectedSecret = process.env.CLEAN_DB_SECRET

    if (!secret || secret !== expectedSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Clear all forecast cache
    const result = await query(`DELETE FROM forecast_cache`)
    log("forecast.cache.cron_cleared", {
      rows_deleted: result.rowCount,
    })

    return NextResponse.json({
      ok: true,
      message: "Forecast cache cleared for all users",
      rows_deleted: result.rowCount,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log("forecast.cache.cron_clear_error", { error: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
