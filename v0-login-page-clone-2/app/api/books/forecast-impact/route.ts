import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { ensureMovementsSchema, query } from "@/lib/db"

export async function GET(request: Request) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const accountCode = searchParams.get("code")

  if (!accountCode) {
    return NextResponse.json({ error: "account code required" }, { status: 400 })
  }

  await ensureMovementsSchema()

  const forecastRows = await query<{ forecast_data: unknown }>(
    `SELECT forecast_data FROM forecast_cache WHERE user_id = $1 LIMIT 1`,
    [user.id]
  )

  const forecastData = forecastRows.rows[0]?.forecast_data as any

  if (!forecastData) {
    return NextResponse.json({
      account_code: accountCode,
      message: "No forecast data available",
      scenarios: [],
    })
  }

  return NextResponse.json({
    account_code: accountCode,
    base_scenario: {
      low_point: forecastData.low_point_cash || 0,
      low_point_date: forecastData.low_point_date || null,
    },
    scenarios: [
      { name: "Conservative", low_point: (forecastData.low_point_cash || 0) * 0.8 },
      { name: "Base", low_point: forecastData.low_point_cash || 0 },
      { name: "Aggressive", low_point: (forecastData.low_point_cash || 0) * 1.2 },
    ],
  })
}
