import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/require-session"
import { query, withTransaction } from "@/lib/db"
import type { PoolClient } from "pg"

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    const userId = session.id

    const body = await request.json() as {
      movement_id: string
      reference_id: string     // e.g. "qbo/214" or "xero/abc"
      component_type: "ar" | "ap"
      entity_id: string        // entity URI e.g. "ar://invoice/qbo/214"
      amount: number
    }

    const { movement_id, reference_id, component_type, entity_id, amount } = body
    if (!movement_id || !reference_id || !component_type || !entity_id || !amount) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 })
    }
    if (!["ar", "ap"].includes(component_type)) {
      return NextResponse.json({ error: "component_type must be ar or ap" }, { status: 400 })
    }

    // Verify movement belongs to user
    const { rows: movRows } = await query<{ id: string; direction: string; amount: string }>(
      `SELECT id, direction, ABS(amount::float)::text AS amount
       FROM movements
       WHERE id = $1 AND user_id = $2 AND duplicate_of IS NULL`,
      [movement_id, userId]
    )
    if (!movRows.length) {
      return NextResponse.json({ error: "Movement not found" }, { status: 404 })
    }

    const applyAmount = Math.min(amount, parseFloat(movRows[0].amount))

    await withTransaction(async (client: PoolClient) => {
      // Remove any prior user-source attribution for this exact movement+reference_id
      // so re-applying is idempotent
      await client.query(
        `DELETE FROM movement_attributions
         WHERE user_id = $1 AND movement_id = $2 AND reference_id = $3 AND source = 'user'`,
        [userId, movement_id, reference_id]
      )

      // Insert the user attribution
      await client.query(
        `INSERT INTO movement_attributions
           (user_id, movement_id, component_type, entity_id, reference_id,
            gross_amount, net_amount, confidence, source, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $6, 1.0, 'user', $7::jsonb)`,
        [
          userId,
          movement_id,
          component_type,
          entity_id,
          reference_id,
          applyAmount,
          JSON.stringify({
            match_method: "manual_user",
            applied_at: new Date().toISOString(),
          }),
        ]
      )

      // Decrement cash_events.outstanding_amount for the matched event
      await client.query(
        `UPDATE cash_events
         SET outstanding_amount = GREATEST(0, outstanding_amount - $3),
             status = CASE
               WHEN GREATEST(0, outstanding_amount - $3) <= 0.01 THEN 'paid'
               WHEN GREATEST(0, outstanding_amount - $3) < amount  THEN 'partially_paid'
               ELSE 'open'
             END,
             last_reconciled_at = NOW(),
             updated_at = NOW()
         WHERE user_id = $1 AND entity_id = $2 AND event_type = $4`,
        [userId, entity_id, applyAmount, component_type]
      )
    })

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("[reconciliation/apply-match] Error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
