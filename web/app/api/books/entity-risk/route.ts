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
  const entityId = searchParams.get("entity_id")

  if (!entityId) {
    return NextResponse.json({ error: "entity_id required" }, { status: 400 })
  }

  await ensureMovementsSchema()

  const profileRows = await query<{
    reliability_score: string
    risk_score: string
    avg_days_to_pay: string
    on_time_payment_rate: string
    recent_trend: string
    payment_count: string
  }>(
    `SELECT reliability_score::text, risk_score::text, avg_days_to_pay::text,
            on_time_payment_rate::text, recent_trend, payment_count::text
     FROM entity_payment_profiles
     WHERE entity_id = $1 AND user_id = $2`,
    [entityId, user.id]
  )

  const profile = profileRows.rows[0]

  if (!profile) {
    return NextResponse.json({
      entity_id: entityId,
      reliability_score: 50,
      risk_score: 50,
      avg_days_to_pay: 0,
      on_time_payment_rate: 0,
      recent_trend: "stable",
      payment_count: 0,
    })
  }

  return NextResponse.json({
    entity_id: entityId,
    reliability_score: Math.round(parseFloat(profile.reliability_score) * 100),
    risk_score: Math.round(parseFloat(profile.risk_score) * 100),
    avg_days_to_pay: Math.round(parseFloat(profile.avg_days_to_pay)),
    on_time_payment_rate: Math.round(parseFloat(profile.on_time_payment_rate) * 100),
    recent_trend: profile.recent_trend || "stable",
    payment_count: parseInt(profile.payment_count),
  })
}
