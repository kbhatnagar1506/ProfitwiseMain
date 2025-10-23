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
import { getPaymentClass, isARAPOperating } from "@/lib/payment-class"
import { filterMerchantDeposits, decomposeMerchantDeposits } from "@/lib/deposit-decompose"

const AUTO_MATCH_CONFIDENCE = 0.75

function isTestEntityName(name: string): boolean {
  const cn = (name ?? "").trim().toLowerCase()
  if (!cn) return true
  if (/\b(test|jruby|jack\s*test)\b/.test(cn)) return true
  if (/^[^\s]+@[^\s]+\.[^\s]+$/.test(cn)) return true
  return false
}

export type InvoiceRow = { invoice_id: string; type: "ar"; display_name: string; amount: number; amount_due: number; due_date: string | null; status: string }
export type BillRow = { bill_id: string; type: "ap"; display_name: string; amount: number; amount_due: number; due_date: string | null; status: string; allocated_total: number; remaining_balance: number; payment_count: number }

export async function GET(req: Request) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const arApOnly = searchParams.get("arApOnly") !== "false" // default: true

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

    type TagRow = { movement_id: string; economic_class: string }
    const { rows: tagRows } = await query<TagRow>(
      `SELECT movement_id, economic_class FROM movement_tags
       WHERE movement_id IN (SELECT id FROM movements WHERE user_id = $1 AND duplicate_of IS NULL)`,
      [user.id]
    )
    const economicClassByMovement = new Map<string, string>()
    for (const t of tagRows) economicClassByMovement.set(t.movement_id, t.economic_class)

    // Auto-match: create allocations for high-confidence deterministic matches
    const unmatchedInflowRows = movementRows.filter((m) => m.direction === "inflow" && !allocatedMovementIds.has(m.id))
    const unmatchedOutflowRows = movementRows.filter((m) => m.direction === "outflow" && !allocatedMovementIds.has(m.id))

    const allInvoices = await fetchInvoicesForReconciliation(user.id)
    const allBills = await fetchOutstandingBills(user.id)
    const invoices = allInvoices.filter((i) => !isTestEntityName(i.customer_name))
    const bills = allBills.filter((b) => !isTestEntityName(b.vendor_name))

    if (unmatchedInflowRows.length > 0) {
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

    // Merchant deposit decomposition: try to match unmatched processor payouts to Stripe
    const stillUnmatchedInflows = movementRows.filter((m) => m.direction === "inflow" && !allocatedMovementIds.has(m.id))
    const merchantDeposits = filterMerchantDeposits(
      stillUnmatchedInflows.map((m) => ({
        movement_id: m.id,
        amount: parseFloat(String(m.amount)),
        date: m.date,
        counterparty: m.counterparty,
      })),
      economicClassByMovement
    )
    if (merchantDeposits.length > 0) {
      const { decomposed } = await decomposeMerchantDeposits(user.id, merchantDeposits, allocatedMovementIds)
      if (decomposed.length > 0) {
        allocations = await getAllocationsForUser(user.id)
        for (const d of decomposed) allocatedMovementIds.add(d.movement_id)
      }
    }
    const unmappedAr = merchantDeposits.filter((d) => !allocatedMovementIds.has(d.movement_id))

    const totalFeesPaid = allocations.reduce((s, a) => s + a.fee_amount, 0)

    // Resolve display names: entity > merchant_tags > counterparty (for AI context)
    const displayInputs = movementRows.map((m) => ({
      movement_id: m.id,
      user_id: user.id,
      counterparty: m.counterparty,
      counterparty_entity_id: m.counterparty_entity_id,
    }))
    const displayNames = await resolveDisplayNames(displayInputs)

    const matchedInflows: { movement_id: string; amount: number; date: string; counterparty: string | null; display_name: string | null; payment_class: string; allocations: { entity_type: string; entity_id: string; gross: number; fee: number; net: number }[] }[] = []
    const matchedOutflows: typeof matchedInflows = []
    const unmatchedInflows: { movement_id: string; amount: number; date: string; counterparty: string | null; display_name: string | null; payment_class: string }[] = []
    const unmatchedOutflows: typeof unmatchedInflows = []

    for (const m of movementRows) {
      const amount = parseFloat(String(m.amount))
      const economicClass = economicClassByMovement.get(m.id) ?? "unknown"
      const payment_class = getPaymentClass(economicClass)
      if (arApOnly && !isARAPOperating(payment_class)) continue

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
        payment_class,
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
      for (const r of entityRows) {
        if (!isTestEntityName(r.canonical_name)) entityNames.set(r.id, r.canonical_name)
      }
    }
    const invoices_rows: InvoiceRow[] = invoices
      .filter((i) => !isTestEntityName(i.customer_name))
      .map((i) => ({
        invoice_id: i.invoice_id,
        type: "ar" as const,
        display_name: (i.entity_id && entityNames.get(i.entity_id)) || i.customer_name || "Unknown",
        amount: i.amount,
        amount_due: i.amount_due,
        due_date: i.due_date,
        status: i.status,
      }))
    const apAllocByBill = new Map<string, { total: number; count: number }>()
    for (const a of allocations) {
      if (a.entity_type !== "ap" || !a.entity_id.startsWith("ap_bill_")) continue
      const billId = a.entity_id.replace(/^ap_bill_/, "")
      const cur = apAllocByBill.get(billId) ?? { total: 0, count: 0 }
      cur.total += a.net_applied
      cur.count += 1
      apAllocByBill.set(billId, cur)
    }
    const bills_rows: BillRow[] = bills
      .filter((b) => !isTestEntityName(b.vendor_name))
      .map((b) => {
        const alloc = apAllocByBill.get(b.bill_id) ?? { total: 0, count: 0 }
        const remaining = Math.max(0, b.amount_due - alloc.total)
        return {
          bill_id: b.bill_id,
          type: "ap" as const,
          display_name: (b.entity_id && entityNames.get(b.entity_id)) || b.vendor_name || "Unknown",
          amount: b.amount,
          amount_due: b.amount_due,
          due_date: b.due_date,
          status: b.status,
          allocated_total: Math.round(alloc.total * 100) / 100,
          remaining_balance: Math.round(remaining * 100) / 100,
          payment_count: alloc.count,
        }
      })

    return NextResponse.json({
      invoices: invoices_rows,
      bills: bills_rows,
      matched_inflows: matchedInflows,
      matched_outflows: matchedOutflows,
      unmatched_inflows: unmatchedInflows,
      unmatched_outflows: unmatchedOutflows,
      unmapped_ar: unmappedAr,
      total_matched_inflows: Math.round(totalMatchedInflows * 100) / 100,
      total_matched_outflows: Math.round(totalMatchedOutflows * 100) / 100,
      total_unmatched_inflows: Math.round(totalUnmatchedInflows * 100) / 100,
      total_unmatched_outflows: Math.round(totalUnmatchedOutflows * 100) / 100,
      total_unmapped_ar: Math.round(unmappedAr.reduce((s, u) => s + u.amount, 0) * 100) / 100,
      total_fees_paid: Math.round(totalFeesPaid * 100) / 100,
      allocation_count: allocations.length,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[AR-AP-Reconciliation] failed:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
