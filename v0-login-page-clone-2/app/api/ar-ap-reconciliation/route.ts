/**
 * AR/AP reconciliation: matched/unmatched payments, fees.
 * GET returns matched inflows, matched outflows, unmatched buckets, total fees.
 */

import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query, ensureMovementsSchema } from "@/lib/db"
import { getAllocationsForUser, createAllocation } from "@/lib/allocation-persist"
import { isFeeAnomaly } from "@/lib/fee-anomaly"
import { matchARPayment, type InflowPayment } from "@/lib/ar-payment-match"
import { matchAPPayment, type PaymentInput } from "@/lib/ap-llm-match"
import { fetchInvoicesForReconciliation } from "@/lib/invoices-fetch"
import { fetchOutstandingBills } from "@/lib/bills-fetch"
import { computeAPStateFromBills } from "@/lib/state/ar-ap"

const AUTO_MATCH_CONFIDENCE = 0.8

export async function GET() {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    await ensureMovementsSchema()
  } catch {
    return NextResponse.json({ error: "Movements schema not available" }, { status: 500 })
  }

  try {
    let allocations = await getAllocationsForUser(user.id)
    const allocatedMovementIds = new Set(allocations.map((a) => a.movement_id))

    type MovementRow = { id: string; direction: string; amount: string; date: string; counterparty: string | null; counterparty_entity_id: string | null; raw_description: string | null }
    const { rows: movementRows } = await query<MovementRow>(
      `SELECT id, direction, amount::float, date, counterparty, counterparty_entity_id, raw_description FROM movements
       WHERE user_id = $1 AND duplicate_of IS NULL
       ORDER BY date DESC`,
      [user.id]
    )

    // Auto-match: create allocations for high-confidence deterministic matches
    const unmatchedInflowRows = movementRows.filter((m) => m.direction === "inflow" && !allocatedMovementIds.has(m.id))
    const unmatchedOutflowRows = movementRows.filter((m) => m.direction === "outflow" && !allocatedMovementIds.has(m.id))

    if (unmatchedInflowRows.length > 0) {
      const invoices = await fetchInvoicesForReconciliation(user.id)
      for (const m of unmatchedInflowRows) {
        const amount = parseFloat(String(m.amount))
        const payment: InflowPayment = {
          movement_id: m.id,
          amount,
          date: m.date,
          entity_id: m.counterparty_entity_id,
          raw_description: m.raw_description,
          counterparty_name: m.counterparty ?? undefined,
        }
        const match = matchARPayment(payment, invoices)
        if (match && match.confidence >= AUTO_MATCH_CONFIDENCE) {
          try {
            await createAllocation(user.id, m.id, "ar", match.invoice_id, match.gross_applied, match.fee_amount, match.net_applied, match.confidence, match.match_method)
            allocatedMovementIds.add(m.id)
          } catch { /* skip */ }
        }
      }
    }

    if (unmatchedOutflowRows.length > 0) {
      const bills = await fetchOutstandingBills(user.id)
      const obligations = computeAPStateFromBills(bills)
      for (const m of unmatchedOutflowRows) {
        const amount = parseFloat(String(m.amount))
        const payment: PaymentInput = {
          movement_id: m.id,
          amount,
          date: m.date,
          raw_description: m.raw_description,
          entity_id: m.counterparty_entity_id,
          counterparty_name: m.counterparty ?? undefined,
        }
        const match = matchAPPayment(payment, obligations)
        if (match && match.confidence >= AUTO_MATCH_CONFIDENCE) {
          try {
            await createAllocation(user.id, m.id, "ap", match.obligation_id, match.gross_applied, match.fee_amount, match.net_applied, match.confidence, match.match_method)
            allocatedMovementIds.add(m.id)
          } catch { /* skip */ }
        }
      }
    }

    allocations = await getAllocationsForUser(user.id)

    const totalFeesPaid = allocations.reduce((s, a) => s + a.fee_amount, 0)

    const matchedInflows: { movement_id: string; amount: number; date: string; counterparty: string | null; allocations: { entity_type: string; entity_id: string; gross: number; fee: number; net: number }[] }[] = []
    const matchedOutflows: typeof matchedInflows = []
    const unmatchedInflows: { movement_id: string; amount: number; date: string; counterparty: string | null }[] = []
    const unmatchedOutflows: typeof unmatchedInflows = []

    for (const m of movementRows) {
      const amount = parseFloat(String(m.amount))
      const allocs = allocations.filter((a) => a.movement_id === m.id)
      const isAllocated = allocs.length > 0

      const entry = {
        movement_id: m.id,
        amount,
        date: m.date,
        counterparty: m.counterparty,
      }

      if (m.direction === "inflow") {
        if (isAllocated) {
          matchedInflows.push({
            ...entry,
            allocations: allocs.map((a) => ({
              entity_type: a.entity_type,
              entity_id: a.entity_id,
              gross: a.gross_applied,
              fee: a.fee_amount,
              net: a.net_applied,
              fee_anomaly: isFeeAnomaly(a.gross_applied, a.fee_amount),
            })),
          })
        } else {
          unmatchedInflows.push(entry)
        }
      } else {
        if (isAllocated) {
          matchedOutflows.push({
            ...entry,
            allocations: allocs.map((a) => ({
              entity_type: a.entity_type,
              entity_id: a.entity_id,
              gross: a.gross_applied,
              fee: a.fee_amount,
              net: a.net_applied,
              fee_anomaly: isFeeAnomaly(a.gross_applied, a.fee_amount),
            })),
          })
        } else {
          unmatchedOutflows.push(entry)
        }
      }
    }

    const totalMatchedInflows = matchedInflows.reduce((s, m) => s + m.amount, 0)
    const totalMatchedOutflows = matchedOutflows.reduce((s, m) => s + m.amount, 0)
    const totalUnmatchedInflows = unmatchedInflows.reduce((s, m) => s + m.amount, 0)
    const totalUnmatchedOutflows = unmatchedOutflows.reduce((s, m) => s + m.amount, 0)

    return NextResponse.json({
      matched_inflows: matchedInflows,
      matched_outflows: matchedOutflows,
      unmatched_inflows: unmatchedInflows,
      unmatched_outflows: unmatchedOutflows,
      total_matched_inflows: Math.round(totalMatchedInflows * 100) / 100,
      total_matched_outflows: Math.round(totalMatchedOutflows * 100) / 100,
      total_unmatched_inflows: Math.round(totalUnmatchedInflows * 100) / 100,
      total_unmatched_outflows: Math.round(totalUnmatchedOutflows * 100) / 100,
      total_fees_paid: Math.round(totalFeesPaid * 100) / 100,
      allocation_count: allocations.length,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[AR-AP-Reconciliation] failed:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
