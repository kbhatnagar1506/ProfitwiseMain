import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query } from "@/lib/db"
import { log } from "@/lib/logger"

/**
 * Forecast Status Polling Endpoint
 * Returns the status of the current forecast computation
 * Frontend polls this to know when forecast is ready
 */
export async function GET() {
  try {
    const cookieStore = await cookies()
    const sessionToken = cookieStore.get(getSessionCookieName())?.value
    const user = await getUserBySessionToken(sessionToken ?? "")

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Check if forecast is being computed
    const statusResult = await query<{
      status: string
      computed_at: string | null
      llm_processing_complete: boolean
    }>(
      `SELECT 
        COALESCE(status, 'idle') as status,
        computed_at,
        COALESCE(llm_processing_complete, false) as llm_processing_complete
       FROM forecast_computation_status 
       WHERE user_id = $1
       ORDER BY updated_at DESC 
       LIMIT 1`,
      [user.id]
    )

    const status = statusResult.rows[0] || {
      status: "idle",
      computed_at: null,
      llm_processing_complete: false,
    }

    log("forecast.status.check", {
      userId: user.id,
      status: status.status,
      llm_complete: status.llm_processing_complete,
    })

    return NextResponse.json({
      status: status.status,
      llm_processing_complete: status.llm_processing_complete,
      computed_at: status.computed_at,
      ready: status.status === "complete" && status.llm_processing_complete,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log("forecast.status.error", { error: message })
    return NextResponse.json(
      { error: "Failed to check forecast status" },
      { status: 500 }
    )
  }
}
