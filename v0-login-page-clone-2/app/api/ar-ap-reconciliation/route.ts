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
import { resolveDisplayNames } from "@/lib/display-name-resolve"

const AUTO_MATCH_CONFIDENCE = 0.8

export type InvoiceRow = { invoice_id: string; type: "ar"; display_name: string; amount: number; amount_due: number; due_date: string | null; status: string }
export type BillRow = { bill_id: string; type: "ap"; display_name: string; amount: number; amount_due: number; due_date: string | null; status: string }

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

    // Resolve display names: entity > merchant_tags > counterparty (for AI context)
    const displayInputs = movementRows.map((m) => ({
      movement_id: m.id,
      user_id: user.id,
      counterparty: m.counterparty,
      counterparty_entity_id: m.counterparty_entity_id,
    }))
    const displayNames = await resolveDisplayNames(displayInputs)

    const matchedInflows: { movement_id: string; amount: number; date: string; counterparty: string | null; display_name: string | null; allocations: { entity_type: string; entity_id: string; gross: number; fee: number; net: number }[] }[] = []
    const matchedOutflows: typeof matchedInflows = []
    const unmatchedInflows: { movement_id: string; amount: number; date: string; counterparty: string | null; display_name: string | null }[] = []
    const unmatchedOutflows: typeof unmatchedInflows = []

    for (const m of movementRows) {
      const amount = parseFloat(String(m.amount))
      const allocs = allocations.filter((a) => a.movement_id === m.id)
      const isAllocated = allocs.length > 0
      const displayRes = displayNames.get(m.id)
      const display_name = displayRes?.display_name ?? null

      const entry = {
        movement_id: m.id,
        amount,
        date: m.date,
        counterparty: m.counterparty,
        display_name,
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

    // Invoices (AR) + Bills (AP) with entity display names for left column
    const invoices = await fetchInvoicesForReconciliation(user.id)
    const bills = await fetchOutstandingBills(user.id)
    const entityIds = [...new Set([
      ...invoices.map((i) => i.entity_id).filter(Boolean),
      ...bills.map((b) => b.entity_id).filter(Boolean),
    ])] as string[]
    const entityNames = new Map<string, string>()
    if (entityIds.length > 0) {
      const { rows: entityRows } = await query<{ id: string; canonical_name: string }>(
        `SELECT id::text, canonical_name FROM entities WHERE id::text = ANY($1)`,
        [entityIds]
      )
      for (const r of entityRows) entityNames.set(r.id, r.canonical_name)
    }
    const invoices_rows: InvoiceRow[] = invoices.map((i) => ({
      invoice_id: i.invoice_id,
      type: "ar",
      display_name: (i.entity_id && entityNames.get(i.entity_id)) || i.customer_name || "Unknown",
      amount: i.amount,
      amount_due: i.amount_due,
      due_date: i.due_date,
      status: i.status,
    }))
    const bills_rows: BillRow[] = bills.map((b) => ({
      bill_id: b.bill_id,
      type: "ap",
      display_name: (b.entity_id && entityNames.get(b.entity_id)) || b.vendor_name || "Unknown",
      amount: b.amount,
      amount_due: b.amount_due,
      due_date: b.due_date,
      status: b.status,
    }))

    return NextResponse.json({
      invoices: invoices_rows,
      bills: bills_rows,
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
