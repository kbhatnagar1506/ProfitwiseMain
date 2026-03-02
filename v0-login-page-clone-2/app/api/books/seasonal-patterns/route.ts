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

  const monthlyRows = await query<{ month: string; total: string }>(
    `SELECT EXTRACT(MONTH FROM m.date)::text AS month, SUM(ABS(m.amount))::text AS total
     FROM movements m
     WHERE m.user_id = $1 AND m.date >= NOW() - INTERVAL '12 months'
     GROUP BY EXTRACT(MONTH FROM m.date)
     ORDER BY month`,
    [user.id]
  )

  const monthlyData = monthlyRows.rows.map(r => ({
    month: parseInt(r.month),
    total: parseFloat(r.total),
  }))

  const avg = monthlyData.reduce((s, m) => s + m.total, 0) / Math.max(monthlyData.length, 1)
  const peakMonths = monthlyData.filter(m => m.total > avg * 1.3).map(m => m.month)
  const lowMonths = monthlyData.filter(m => m.total < avg * 0.7).map(m => m.month)

  return NextResponse.json({
    account_code: accountCode,
    average_monthly: Math.round(avg),
    peak_months: peakMonths,
    low_months: lowMonths,
    monthly_data: monthlyData,
  })
}
