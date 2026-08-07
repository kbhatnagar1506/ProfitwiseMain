import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query } from "@/lib/db"
import { log } from "@/lib/logger"

async function getUser() {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  return getUserBySessionToken(sessionToken ?? "")
}

export async function POST() {
  try {
    const user = await getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const body = await (await import("next/server")).NextRequest.prototype.json.call(
      new (await import("next/server")).NextRequest(new Request("http://localhost", { method: "POST" }))
    )

    const { intervention_id, decision, notes, forecast_id } = body

    if (!intervention_id || !decision) {
      return NextResponse.json(
        { error: "Missing required fields: intervention_id, decision" },
        { status: 400 }
      )
    }

    if (!["selected", "rejected", "deferred"].includes(decision)) {
      return NextResponse.json(
        { error: "Invalid decision value" },
        { status: 400 }
      )
    }

    // Save user decision
    const result = await query(
      `INSERT INTO user_intervention_decisions (user_id, forecast_id, intervention_id, decision, notes)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, intervention_id) DO UPDATE SET
         decision = $4,
         notes = $5,
         updated_at = NOW()
       RETURNING id`,
      [user.id, forecast_id || null, intervention_id, decision, notes || null]
    )

    log("forecast.user_decision.saved", {
      userId: user.id,
      interventionId: intervention_id,
      decision,
    })

    return NextResponse.json({
      success: true,
      decision_id: result.rows[0].id,
    })
  } catch (err) {
    log("forecast.user_decision.error", { error: String(err) })
    return NextResponse.json(
      { error: "Failed to save decision" },
      { status: 500 }
    )
  }
}

export async function GET() {
  try {
    const user = await getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Get user's recent decisions
    const result = await query(
      `SELECT intervention_id, decision, notes, created_at
       FROM user_intervention_decisions
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 100`,
      [user.id]
    )

    return NextResponse.json({
      decisions: result.rows,
    })
  } catch (err) {
    log("forecast.user_decision.fetch_error", { error: String(err) })
    return NextResponse.json(
      { error: "Failed to fetch decisions" },
      { status: 500 }
    )
  }
}
