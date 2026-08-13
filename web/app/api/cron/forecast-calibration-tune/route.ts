import { NextRequest, NextResponse } from "next/server"
import { runCalibrationTuneJob } from "@/lib/forecast-calibration-tune"
import { log } from "@/lib/logger"

/**
 * POST /api/cron/forecast-calibration-tune?userId=<uuid>
 * Runs grid-search calibration tuning for a user's forecast model.
 * Auth: x-clean-db-secret header. Production only.
 */
export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV !== "production") {
    return NextResponse.json({ error: "Only available in production" }, { status: 403 })
  }
  const secret = req.headers.get("x-clean-db-secret") ?? ""
  const expected = process.env.CLEAN_DB_SECRET
  if (!expected || secret !== expected) {
    log("cron.forecast-calibration-tune.unauthorized", undefined, "forecast")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const userId = req.nextUrl.searchParams.get("userId")?.trim()
  if (!userId) {
    return NextResponse.json({ error: "userId query parameter required" }, { status: 400 })
  }

  try {
    log("cron.forecast-calibration-tune.start", { userId }, "forecast")
    const result = await runCalibrationTuneJob(userId)
    log("cron.forecast-calibration-tune.complete", { userId, ...result }, "forecast")
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log("cron.forecast-calibration-tune.failed", { userId, error: message }, "error")
    return NextResponse.json({ error: "Calibration tuning failed", message }, { status: 500 })
  }
}
