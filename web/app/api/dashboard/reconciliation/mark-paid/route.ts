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
      event_id: string
      action: "paid" | "unpaid"
      note?: string
    }

    const { event_id, action, note } = body
    if (!event_id || !action || !["paid", "unpaid"].includes(action)) {
      return NextResponse.json({ error: "Invalid body" }, { status: 400 })
    }

    // Fetch the cash_event to get its current values
    const { rows: eventRows } = await query<{
      id: string
      event_type: string
      amount: string
      outstanding_amount: string | null
      entity_id: string
      status: string
    }>(
      `SELECT id, event_type, amount::text, outstanding_amount::text, entity_id, status
       FROM cash_events
       WHERE id = $1 AND user_id = $2`,
      [event_id, userId]
    )

    if (!eventRows.length) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }

    const evt = eventRows[0]
    const amount = parseFloat(evt.amount)
    const currentOutstanding = parseFloat(evt.outstanding_amount ?? evt.amount)
    const componentType = evt.event_type === "ar" ? "ar" : "ap"

    await withTransaction(async (client: PoolClient) => {
      if (action === "paid") {
        // Mark paid: set outstanding to 0, status = paid, tag metadata
        await client.query(
          `UPDATE cash_events
           SET outstanding_amount = 0,
               status = 'paid',
               last_reconciled_at = NOW(),
               updated_at = NOW(),
               metadata = metadata || $3::jsonb
           WHERE id = $1 AND user_id = $2`,
          [
            event_id,
            userId,
            JSON.stringify({
              manual_paid: true,
              manual_paid_at: new Date().toISOString(),
              manual_paid_note: note ?? null,
            }),
          ]
        )

        // Remove any previous user-source attribution for this event (idempotent)
        await client.query(
          `DELETE FROM movement_attributions
           WHERE user_id = $1 AND entity_id = $2 AND source = 'user'`,
          [userId, evt.entity_id]
        )

        // Insert a sentinel user attribution so unmatched queries skip this event
        if (currentOutstanding > 0.01) {
          await client.query(
            `INSERT INTO movement_attributions
               (user_id, movement_id, component_type, entity_id, reference_id,
                gross_amount, net_amount, confidence, source, metadata)
             VALUES ($1, NULL, $2, $3, $4, $5, $5, 1.0, 'user', $6::jsonb)
             ON CONFLICT DO NOTHING`,
            [
              userId,
              componentType,
              evt.entity_id,
              evt.entity_id,
              currentOutstanding,
              JSON.stringify({ manual_paid: true, note: note ?? null }),
            ]
          )
        }
      } else {
        // Mark unpaid: restore outstanding to full amount, clear manual metadata
        await client.query(
          `UPDATE cash_events
           SET outstanding_amount = $3,
               status = 'open',
               last_reconciled_at = NULL,
               updated_at = NOW(),
               metadata = metadata - 'manual_paid' - 'manual_paid_at' - 'manual_paid_note'
           WHERE id = $1 AND user_id = $2`,
          [event_id, userId, amount]
        )

        // Remove the user-source sentinel attribution
        await client.query(
          `DELETE FROM movement_attributions
           WHERE user_id = $1 AND entity_id = $2 AND source = 'user'`,
          [userId, evt.entity_id]
        )
      }
    })

    const { rows: updated } = await query<{
      id: string
      status: string
      outstanding_amount: string
    }>(
      `SELECT id, status, outstanding_amount::text FROM cash_events WHERE id = $1`,
      [event_id]
    )

    return NextResponse.json({
      success: true,
      updated: {
        id: updated[0].id,
        status: updated[0].status,
        outstanding_amount: parseFloat(updated[0].outstanding_amount ?? "0"),
      },
    })
  } catch (err) {
    console.error("[reconciliation/mark-paid] Error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
