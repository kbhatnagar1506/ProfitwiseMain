import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query, withTransaction } from "@/lib/db"

export async function POST(request: NextRequest) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    const body = await request.json()
    const { movement_id, matches } = body

    if (!movement_id || !Array.isArray(matches) || matches.length === 0) {
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 })
    }

    // Validate that all matches have required fields
    for (const match of matches) {
      if (!match.reference_id || !match.component_type || typeof match.amount !== "number") {
        return NextResponse.json({ error: "Invalid match format" }, { status: 400 })
      }
    }

    // Validate total matched amount
    const totalMatched = matches.reduce((sum, m) => sum + m.amount, 0)
    const { rows: movementRows } = await query<{ amount: string }>(
      `SELECT amount::text FROM movements WHERE id = $1 AND user_id = $2`,
      [movement_id, user.id]
    )

    if (movementRows.length === 0) {
      return NextResponse.json({ error: "Movement not found" }, { status: 404 })
    }

    const movementAmount = parseFloat(movementRows[0].amount)
    if (totalMatched > Math.abs(movementAmount) + 0.01) {
      return NextResponse.json({ error: "Total matched amount exceeds movement amount" }, { status: 400 })
    }

    // Apply matches in a transaction
    await withTransaction(async (client) => {
      // Delete any prior user-source attributions for this movement
      await client.query(
        `DELETE FROM movement_attributions 
         WHERE movement_id = $1 AND user_id = $2 AND source = 'user'`,
        [movement_id, user.id]
      )

      // Insert new attributions for each match
      for (const match of matches) {
        // Insert attribution
        await client.query(
          `INSERT INTO movement_attributions 
           (user_id, movement_id, component_type, entity_id, reference_id, net_amount, confidence, source, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, 1.0, 'user', '{}')`,
          [user.id, movement_id, match.component_type, "", match.reference_id, match.amount]
        )

        // Update cash_events outstanding_amount
        const { rows: cashEventRows } = await client.query<{ id: string; outstanding_amount: string }>(
          `SELECT id, outstanding_amount::text FROM cash_events 
           WHERE user_id = $1 AND reference_id = $2 AND event_type = $3`,
          [user.id, match.reference_id, match.component_type === "ar" ? "ar" : "ap"]
        )

        if (cashEventRows.length > 0) {
          const cashEvent = cashEventRows[0]
          const currentOutstanding = parseFloat(cashEvent.outstanding_amount)
          const newOutstanding = Math.max(0, currentOutstanding - match.amount)
          const newStatus = newOutstanding <= 0.01 ? "paid" : newOutstanding < currentOutstanding ? "partially_paid" : "open"

          await client.query(
            `UPDATE cash_events 
             SET outstanding_amount = $1, status = $2, updated_at = NOW()
             WHERE id = $3`,
            [newOutstanding, newStatus, cashEvent.id]
          )
        }
      }
    })

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("[reconciliation/split-match] Error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
