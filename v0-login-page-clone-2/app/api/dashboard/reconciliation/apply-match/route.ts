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
      // Step 1: Remove any prior user-source attribution for this exact movement+reference_id
      // so re-applying is idempotent
      await client.query(
        `DELETE FROM movement_attributions
         WHERE user_id = $1 AND movement_id = $2 AND reference_id = $3 AND source = 'user'`,
        [userId, movement_id, reference_id]
      )

      // Step 2: Insert the user attribution (Link movement to AR/AP)
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

      // Step 3: Update cash_events (Decrement outstanding_amount and update status)
      const cashEventResult = await client.query<{ outstanding_amount: string; amount: string }>(
        `SELECT outstanding_amount, amount FROM cash_events
         WHERE user_id = $1 AND entity_id = $2 AND event_type = $3`,
        [userId, entity_id, component_type]
      )
      
      if (cashEventResult.rows.length > 0) {
        const cashEvent = cashEventResult.rows[0]
        const currentOutstanding = parseFloat(cashEvent.outstanding_amount)
        const newOutstanding = Math.max(0, currentOutstanding - applyAmount)
        const totalAmount = parseFloat(cashEvent.amount)
        
        // Smart status: paid if fully matched, partially_paid if partial, open if no match
        let newStatus = 'open'
        if (newOutstanding <= 0.01) {
          newStatus = 'paid'
        } else if (newOutstanding < totalAmount) {
          newStatus = 'partially_paid'
        }
        
        await client.query(
          `UPDATE cash_events
           SET outstanding_amount = $3,
               status = $4,
               last_reconciled_at = NOW(),
               updated_at = NOW()
           WHERE user_id = $1 AND entity_id = $2 AND event_type = $5`,
          [userId, entity_id, newOutstanding, newStatus, component_type]
        )
      }

      // Step 4: Update entities table (Ripple effect - update open_ar/open_ap and lifetime_value)
      // Extract the actual entity ID from the entity_id URI (e.g., "ar://invoice/qbo/214" -> extract customer entity)
      // First, find the entity associated with this invoice/bill
      const entityResult = await client.query<{ entity_id: string }>(
        `SELECT DISTINCT e.id as entity_id
         FROM entities e
         WHERE e.user_id = $1 
         AND (
           (e.id = (SELECT entity_id FROM qbo_invoices WHERE id = $2 AND user_id = $1))
           OR (e.id = (SELECT entity_id FROM qbo_bills WHERE id = $2 AND user_id = $1))
           OR (e.id = (SELECT entity_id FROM xero_invoices WHERE id = $2 AND user_id = $1))
           OR (e.id = (SELECT entity_id FROM xero_bills WHERE id = $2 AND user_id = $1))
         )
         LIMIT 1`,
        [userId, reference_id]
      )

      if (entityResult.rows.length > 0) {
        const actualEntityId = entityResult.rows[0].entity_id
        const arOrAp = component_type === 'ar' ? 'open_ar' : 'open_ap'
        
        // Update entity: decrease open_ar/open_ap, increase lifetime_value
        await client.query(
          `UPDATE entities
           SET ${arOrAp} = GREATEST(0, ${arOrAp} - $2),
               lifetime_value = lifetime_value + $2,
               last_transaction_date = NOW(),
               updated_at = NOW()
           WHERE id = $1 AND user_id = $3`,
          [actualEntityId, applyAmount, userId]
        )
        
        console.log(`[reconciliation/apply-match] Ripple effect: ${arOrAp} decreased by $${applyAmount}, lifetime_value increased for entity ${actualEntityId}`)
      }
    })

    return NextResponse.json({ 
      success: true,
      message: "Match applied with ripple effect - entities updated"
    })
  } catch (err) {
    console.error("[reconciliation/apply-match] Error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
