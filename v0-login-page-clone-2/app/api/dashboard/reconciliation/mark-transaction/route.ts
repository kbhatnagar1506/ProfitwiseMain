import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query } from "@/lib/db"
import { log } from "@/lib/logger"

type MarkTransactionRequest = {
  transaction_id: string
  status: "paid" | "unpaid"
  linked_ar_ap_ids?: string[]
}

export async function POST(request: NextRequest) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")

  if (!user) {
    log("reconciliation.mark_transaction.unauthorized", { reason: "no_session" })
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const userId = user.id
    const body: MarkTransactionRequest = await request.json()
    const { transaction_id, status, linked_ar_ap_ids } = body

    if (!transaction_id || !status) {
      return NextResponse.json(
        { error: "Missing required fields: transaction_id, status" },
        { status: 400 }
      )
    }

    // Get the movement to find its amount
    const movement = await query<{ amount: string; direction: string }>(
      `SELECT amount, direction FROM movements WHERE id = $1 AND user_id = $2`,
      [transaction_id, userId]
    ).then((r) => r.rows[0])

    if (!movement) {
      return NextResponse.json({ error: "Transaction not found" }, { status: 404 })
    }

    const amount = parseFloat(movement.amount)

    if (status === "paid") {
      // Mark as paid: create movement_attributions for linked AR/AP items
      if (linked_ar_ap_ids && linked_ar_ap_ids.length > 0) {
        // Delete existing attributions for this movement
        await query(
          `DELETE FROM movement_attributions WHERE movement_id = $1 AND user_id = $2`,
          [transaction_id, userId]
        )

        // Create new attributions for each linked AR/AP item
        for (const entity_id of linked_ar_ap_ids) {
          const component_type = await query<{ event_type: string }>(
            `SELECT event_type FROM cash_events WHERE entity_id = $1 AND user_id = $2 LIMIT 1`,
            [entity_id, userId]
          ).then((r) => r.rows[0]?.event_type)

          if (component_type) {
            await query(
              `INSERT INTO movement_attributions (movement_id, user_id, entity_id, component_type, net_amount, created_at)
               VALUES ($1, $2, $3, $4, $5, NOW())
               ON CONFLICT DO NOTHING`,
              [transaction_id, userId, entity_id, component_type === "ar" ? "ar" : "ap", amount]
            )
          }
        }
      }
    } else if (status === "unpaid") {
      // Mark as unpaid: remove movement_attributions
      await query(
        `DELETE FROM movement_attributions WHERE movement_id = $1 AND user_id = $2`,
        [transaction_id, userId]
      )
    }

    // Trigger reconciliation recalculation
    try {
      const reconcileResponse = await fetch(
        `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/api/ar-ap-step?run=true`,
        { method: "GET" }
      )
      if (!reconcileResponse.ok) {
        log("reconciliation.mark_transaction.reconcile_failed", {
          status: reconcileResponse.status,
        })
      }
    } catch (err) {
      log("reconciliation.mark_transaction.reconcile_error", { error: String(err) })
    }

    log("reconciliation.mark_transaction.success", {
      userId,
      transaction_id,
      status,
      linked_count: linked_ar_ap_ids?.length || 0,
    })

    return NextResponse.json({
      success: true,
      message: `Transaction marked as ${status}`,
      transaction_id,
    })
  } catch (error) {
    log("reconciliation.mark_transaction.error", { error: String(error) })
    return NextResponse.json(
      { error: "Failed to mark transaction" },
      { status: 500 }
    )
  }
}
