import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query } from "@/lib/db"
import { fetchInvoicesForReconciliation, enrichInvoicesWithReconciliationStatus } from "@/lib/invoices-fetch"
import { fetchBillsForReconciliation, enrichBillsWithReconciliationStatus } from "@/lib/bills-fetch"
import type { OutstandingInvoice, OutstandingBill } from "@/lib/state/types"

interface Movement {
  id: string
  date: string
  direction: "inflow" | "outflow"
  amount: number
  description: string
  counterparty: string | null
  economic_class: string | null
  movement_type: string | null
}

interface Match {
  movement_id: string
  reference_id: string
  component_type: "ar" | "ap"
  entity_id: string
  confidence: number
  entity_name: string
  amount: number
}

interface TransferPair {
  outflow_id: string
  inflow_id: string
  amount: number
  date_diff_days: number
}

export async function GET(request: Request) {
  try {
    const cookieStore = await cookies()
    const sessionToken = cookieStore.get(getSessionCookieName())?.value
    const user = await getUserBySessionToken(sessionToken ?? "")
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const userId = user.id

    // Fetch unmatched movements (excluding transfers and non-operating movements)
    const { rows: unmatchedMovements } = await query<Movement>(
      `SELECT 
         m.id, m.date, m.direction, ABS(m.amount::float) as amount,
         m.raw_description as description, m.counterparty,
         mt.economic_class, m.movement_type
       FROM movements m
       LEFT JOIN movement_tags mt ON m.id = mt.movement_id
       WHERE m.user_id = $1 
         AND m.duplicate_of IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM movement_attributions ma
           WHERE ma.movement_id = m.id AND ma.source IN ('rule', 'model', 'llm')
         )
         AND (mt.economic_class IS NULL OR mt.economic_class NOT IN (
           'transfer', 'bank_fee', 'interest', 'owner_draw', 'owner_contribution',
           'processor_fee', 'processor_payout', 'opening_balance', 'account_verification',
           'system_adjustment', 'settlement_in', 'settlement_adjustment'
         ))
       ORDER BY m.date DESC
       LIMIT 100`,
      [userId]
    )

    // Fetch open AR and AP
    const invoices = await fetchInvoicesForReconciliation(userId)
    const bills = await fetchBillsForReconciliation(userId)
    
    const enrichedInvoices = await enrichInvoicesWithReconciliationStatus(userId, invoices)
    const enrichedBills = await enrichBillsWithReconciliationStatus(userId, bills)

    const openAr = enrichedInvoices.filter(i => i.status !== "paid")
    const openAp = enrichedBills.filter(b => b.status !== "paid")

    const totalArWaiting = openAr.reduce((sum, i) => sum + i.amount_due, 0)
    const totalApWaiting = openAp.reduce((sum, b) => sum + b.amount_due, 0)

    // Calculate total unmatched cash
    const totalUnmatchedInflows = unmatchedMovements
      .filter(m => m.direction === "inflow")
      .reduce((sum, m) => sum + m.amount, 0)
    const totalUnmatchedOutflows = unmatchedMovements
      .filter(m => m.direction === "outflow")
      .reduce((sum, m) => sum + m.amount, 0)

    // Fetch AI suggestions (high-confidence matches from LLM)
    const { rows: aiSuggestions } = await query<Match>(
      `SELECT 
         ma.movement_id, ma.reference_id, ma.component_type, ma.entity_id,
         ma.confidence, e.canonical_name as entity_name, ma.gross_amount as amount
       FROM movement_attributions ma
       JOIN entities e ON ma.entity_id = e.id
       WHERE ma.user_id = $1 AND ma.source = 'llm' AND ma.confidence >= 0.7
       ORDER BY ma.confidence DESC
       LIMIT 50`,
      [userId]
    )

    const highConfidence = aiSuggestions.filter(s => s.confidence >= 0.9)
    const mediumConfidence = aiSuggestions.filter(s => s.confidence >= 0.7 && s.confidence < 0.9)
    const lowConfidence = aiSuggestions.filter(s => s.confidence < 0.7)

    // Fetch internal transfers (paired and unpaired)
    const { rows: pairedTransfers } = await query<TransferPair>(
      `SELECT 
         m1.id as outflow_id, m2.id as inflow_id, ABS(m1.amount::float) as amount,
         EXTRACT(DAY FROM (m2.date - m1.date))::int as date_diff_days
       FROM movements m1
       JOIN movements m2 ON m1.user_id = m2.user_id
         AND ABS(m1.amount::float) = ABS(m2.amount::float)
         AND m1.direction = 'outflow' AND m2.direction = 'inflow'
         AND m2.date - m1.date BETWEEN INTERVAL '0 days' AND INTERVAL '3 days'
       WHERE m1.user_id = $1
         AND m1.duplicate_of IS NULL AND m2.duplicate_of IS NULL
       ORDER BY m1.date DESC`,
      [userId]
    )

    const { rows: unpairedTransfers } = await query<Movement>(
      `SELECT 
         m.id, m.date, m.direction, ABS(m.amount::float) as amount,
         m.raw_description as description, m.counterparty,
         mt.economic_class, m.movement_type
       FROM movements m
       LEFT JOIN movement_tags mt ON m.id = mt.movement_id
       WHERE m.user_id = $1 
         AND m.duplicate_of IS NULL
         AND mt.economic_class = 'transfer'
         AND NOT EXISTS (
           SELECT 1 FROM movements m2
           WHERE m2.user_id = $1
             AND ABS(m2.amount::float) = ABS(m.amount::float)
             AND m2.direction != m.direction
             AND m2.date - m.date BETWEEN INTERVAL '-3 days' AND INTERVAL '3 days'
             AND m2.duplicate_of IS NULL
         )
       ORDER BY m.date DESC`,
      [userId]
    )

    // Calculate reconciliation stats
    const { rows: statsRows } = await query<{ matched_today: string; matched_week: string; match_rate: string }>(
      `SELECT 
         COUNT(CASE WHEN ma.created_at >= NOW() - INTERVAL '1 day' THEN 1 END)::text as matched_today,
         COUNT(CASE WHEN ma.created_at >= NOW() - INTERVAL '7 days' THEN 1 END)::text as matched_week,
         ROUND(100.0 * COUNT(CASE WHEN ma.source IN ('rule', 'model', 'llm', 'user') THEN 1 END) / 
           NULLIF(COUNT(*), 0), 1)::text as match_rate
       FROM movement_attributions ma
       WHERE ma.user_id = $1`,
      [userId]
    )

    const stats = statsRows[0] || { matched_today: "0", matched_week: "0", match_rate: "0" }

    return NextResponse.json({
      unmatched_movements: {
        inflows: unmatchedMovements.filter(m => m.direction === "inflow"),
        outflows: unmatchedMovements.filter(m => m.direction === "outflow"),
        total_inflows: totalUnmatchedInflows,
        total_outflows: totalUnmatchedOutflows,
      },
      open_ar: openAr,
      open_ap: openAp,
      total_ar_waiting: totalArWaiting,
      total_ap_waiting: totalApWaiting,
      ai_suggestions: {
        high_confidence: highConfidence,
        medium_confidence: mediumConfidence,
        low_confidence: lowConfidence,
      },
      internal_transfers: {
        paired: pairedTransfers,
        unpaired: unpairedTransfers,
      },
      reconciliation_stats: {
        total_matched_today: parseInt(stats.matched_today),
        total_matched_this_week: parseInt(stats.matched_week),
        match_rate_pct: parseFloat(stats.match_rate),
      },
    })
  } catch (err) {
    console.error("[clearing-house] Error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
