import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/require-session"
import { query, withTransaction } from "@/lib/db"
import { statusFromOutstanding, writeStatusChange } from "@/lib/ar-ap-status"
import type { PoolClient } from "pg"

export async function DELETE(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    const userId = session.id

    const body = await request.json() as { attribution_id: string }
    const { attribution_id } = body
    if (!attribution_id) {
      return NextResponse.json({ error: "attribution_id required" }, { status: 400 })
    }

    // Fetch the attribution to get entity_id, component_type, net_amount before deleting
    const { rows: attrRows } = await query<{
      id: string
      entity_id: string
      component_type: string
      net_amount: string
      reference_id: string | null
    }>(
      `SELECT id, entity_id, component_type, net_amount::text, reference_id
       FROM movement_attributions
       WHERE id = $1 AND user_id = $2`,
      [attribution_id, userId]
    )

    if (!attrRows.length) {
      return NextResponse.json({ error: "Attribution not found" }, { status: 404 })
    }

    const attr = attrRows[0]
    const netAmount = parseFloat(attr.net_amount)

    await withTransaction(async (client: PoolClient) => {
      // Delete the attribution
      await client.query(
        `DELETE FROM movement_attributions WHERE id = $1 AND user_id = $2`,
        [attribution_id, userId]
      )

      // Re-aggregate outstanding from remaining attributions for this cash_event
      // (identified by entity_id + event_type matching component_type)
      const eventType = attr.component_type === "ar" ? "ar" : "ap"

      const { rows: ceRows } = await client.query<{ amount: string }>(
        `SELECT amount::text FROM cash_events
         WHERE user_id = $1 AND entity_id = $2 AND event_type = $3`,
        [userId, attr.entity_id, eventType]
      )

      if (ceRows.length > 0) {
        const originalAmount = parseFloat(ceRows[0].amount)

        // Sum remaining net_amount for this entity's attributions
        const { rows: sumRows } = await client.query<{ total: string }>(
          `SELECT COALESCE(SUM(net_amount), 0)::text AS total
           FROM movement_attributions
           WHERE user_id = $1 AND entity_id = $2 AND component_type = $3`,
          [userId, attr.entity_id, attr.component_type]
        )
        const matched = parseFloat(sumRows[0].total)
        const newOutstanding = Math.max(0, originalAmount - matched)
        const newStatus =
          newOutstanding <= 0.01
            ? "paid"
            : newOutstanding < originalAmount
              ? "partially_paid"
              : "open"

        await client.query(
          `UPDATE cash_events
           SET outstanding_amount = $3,
               status = $4,
               updated_at = NOW()
           WHERE user_id = $1 AND entity_id = $2 AND event_type = $5`,
          [userId, attr.entity_id, newOutstanding, newStatus, eventType]
        )
      } else {
        // Fallback: cash_event not found by entity_id — restore by adding net_amount back.
        // F4: Also update status (was missing before — left status stale after unmatch).
        await client.query(
          `UPDATE cash_events
           SET outstanding_amount = LEAST(amount, outstanding_amount + $3),
               status = CASE
                 WHEN LEAST(amount, outstanding_amount + $3) <= 0.01   THEN 'paid'
                 WHEN LEAST(amount, outstanding_amount + $3) < amount  THEN 'partially_paid'
                 ELSE 'open'
               END,
               updated_at = NOW()
           WHERE user_id = $1 AND event_type = $2
             AND entity_id LIKE $4`,
          [userId, eventType, netAmount, `%${attr.reference_id ?? attr.entity_id}%`]
        )
      }

      // Clear manual_paid metadata if this was a manual payment sentinel
      await client.query(
        `UPDATE cash_events
         SET metadata = metadata - 'manual_paid' - 'manual_paid_at' - 'manual_paid_note',
             updated_at = NOW()
         WHERE user_id = $1 AND entity_id = $2 AND (metadata->>'manual_paid')::boolean = true`,
        [userId, attr.entity_id]
      )
    })

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("[reconciliation/unmatch] Error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
