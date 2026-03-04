import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { ensureMovementsSchema, query } from "@/lib/db"

export async function GET(request: Request) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  await ensureMovementsSchema()

  const forecastRows = await query<{ forecast_data: unknown }>(
    `SELECT forecast_data FROM forecast_cache WHERE user_id = $1 LIMIT 1`,
    [user.id]
  )

  const forecastData = forecastRows.rows[0]?.forecast_data as any

  return NextResponse.json({
    forecast: forecastData || {},
    scenarios: [
      { name: "Conservative", color: "#ef4444" },
      { name: "Base", color: "#3b82f6" },
      { name: "Aggressive", color: "#10b981" },
    ],
  })
}
