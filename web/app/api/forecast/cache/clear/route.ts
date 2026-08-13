import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query } from "@/lib/db"
import { log } from "@/lib/logger"

async function getUser() {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  return getUserBySessionToken(sessionToken ?? "")
}

/**
 * POST /api/forecast/cache/clear
 * Clear forecast cache for current user
 */
export async function POST(request: NextRequest) {
  try {
    const user = await getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    await query(`DELETE FROM forecast_cache WHERE user_id = $1`, [user.id])
    log("forecast.cache.cleared", { userId: user.id })

    return NextResponse.json({
      ok: true,
      userId: user.id,
      message: "Forecast cache cleared",
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log("forecast.cache.clear_error", { error: message })
    return NextResponse.json({ error: "Failed to clear cache" }, { status: 500 })
  }
}
