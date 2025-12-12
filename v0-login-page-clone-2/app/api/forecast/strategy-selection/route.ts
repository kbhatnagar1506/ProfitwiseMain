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

    const { strategy_id, selected, implementation_notes, forecast_id } = body

    if (!strategy_id) {
      return NextResponse.json(
        { error: "Missing required field: strategy_id" },
        { status: 400 }
      )
    }

    // Save strategy selection
    const result = await query(
      `INSERT INTO user_strategy_selections (user_id, forecast_id, strategy_id, selected, implementation_notes)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, strategy_id) DO UPDATE SET
         selected = $4,
         implementation_notes = $5,
         updated_at = NOW()
       RETURNING id`,
      [user.id, forecast_id || null, strategy_id, selected || false, implementation_notes || null]
    )

    log("forecast.strategy_selection.saved", {
      userId: user.id,
      strategyId: strategy_id,
      selected,
    })

    return NextResponse.json({
      success: true,
      selection_id: result.rows[0].id,
    })
  } catch (err) {
    log("forecast.strategy_selection.error", { error: String(err) })
    return NextResponse.json(
      { error: "Failed to save strategy selection" },
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

    // Get user's strategy selections
    const result = await query(
      `SELECT strategy_id, selected, implementation_notes, created_at
       FROM user_strategy_selections
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 100`,
      [user.id]
    )

    return NextResponse.json({
      selections: result.rows,
    })
  } catch (err) {
    log("forecast.strategy_selection.fetch_error", { error: String(err) })
    return NextResponse.json(
      { error: "Failed to fetch strategy selections" },
      { status: 500 }
    )
  }
}
