/**
 * Reconciliation job runner. Runs in background, writes result to reconciliation_cache.
 */

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

export type ReconciliationResult = {
  invoices: unknown[]
  bills: unknown[]
  matched_inflows: unknown[]
  matched_outflows: unknown[]
  unmatched_inflows: unknown[]
  unmatched_outflows: unknown[]
  unmapped_ar: unknown[]
  total_matched_inflows: number
  total_matched_outflows: number
  total_unmatched_inflows: number
  total_unmatched_outflows: number
  total_unmapped_ar: number
  total_fees_paid: number
  allocation_count: number
}

export async function runReconciliationJob(userId: string, arApOnly: boolean): Promise<ReconciliationResult> {
  await ensureMovementsSchema()

  let allocations = await getAllocationsForUser(userId)
  const allocatedMovementIds = new Set(allocations.map((a) => a.movement_id))

  type MovementRow = { id: string; direction: string; amount: string; date: string; counterparty: string | null; counterparty_entity_id: string | null; raw_description: string | null }
  const { rows: movementRows } = await query<MovementRow>(
    `SELECT id, direction, amount::float, date, counterparty, counterparty_entity_id, raw_description FROM movements
     WHERE user_id = $1 AND duplicate_of IS NULL ORDER BY date DESC`,
    [userId]
  )

  type TagRow = { movement_id: string; economic_class: string }
  const { rows: tagRows } = await query<TagRow>(
    `SELECT movement_id, economic_class FROM movement_tags
     WHERE movement_id IN (SELECT id FROM movements WHERE user_id = $1 AND duplicate_of IS NULL)`,
    [userId]
  )
  const economicClassByMovement = new Map<string, string>()
  for (const t of tagRows) economicClassByMovement.set(t.movement_id, t.economic_class)

  const unmatchedInflowRows = movementRows.filter((m) => m.direction === "inflow" && !allocatedMovementIds.has(m.id))
  const unmatchedOutflowRows = movementRows.filter((m) => m.direction === "outflow" && !allocatedMovementIds.has(m.id))

  const allInvoices = await fetchInvoicesForReconciliation(userId)
  const allBills = await fetchOutstandingBills(userId)
  const invoices = allInvoices.filter((i) => !isTestEntityName(i.customer_name))
  const bills = allBills.filter((b) => !isTestEntityName(b.vendor_name))

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
        await createAllocation(userId, m.id, "ar", match.invoice_id, match.gross_applied, match.fee_amount, match.net_applied, match.confidence, match.match_method)
        allocatedMovementIds.add(m.id)
      } catch { /* skip */ }
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
          await createAllocation(userId, m.id, "ap", match.obligation_id, match.gross_applied, match.fee_amount, match.net_applied, match.confidence, match.match_method)
          allocatedMovementIds.add(m.id)
        } catch { /* skip */ }
      }
    }
  }

  allocations = await getAllocationsForUser(userId)

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
    const { decomposed } = await decomposeMerchantDeposits(userId, merchantDeposits, allocatedMovementIds)
    if (decomposed.length > 0) {
      allocations = await getAllocationsForUser(userId)
      for (const d of decomposed) allocatedMovementIds.add(d.movement_id)
    }
  }
  const unmappedAr = merchantDeposits.filter((d) => !allocatedMovementIds.has(d.movement_id))

  const totalFeesPaid = allocations.reduce((s, a) => s + a.fee_amount, 0)
  const displayInputs = movementRows.map((m) => ({
    movement_id: m.id,
    user_id: userId,
    counterparty: m.counterparty,
    counterparty_entity_id: m.counterparty_entity_id,
  }))
  const displayNames = await resolveDisplayNames(displayInputs)

  const matchedInflows: unknown[] = []
  const matchedOutflows: unknown[] = []
  const unmatchedInflows: unknown[] = []
  const unmatchedOutflows: unknown[] = []

  for (const m of movementRows) {
    const amount = parseFloat(String(m.amount))
    const ec = economicClassByMovement.get(m.id) ?? "unknown"
    const payment_class = getPaymentClass(ec)
    if (arApOnly && !isARAPOperating(payment_class)) continue

    const allocs = allocations.filter((a) => a.movement_id === m.id)
    const isAllocated = allocs.length > 0
    const display_name = displayNames.get(m.id)?.display_name ?? null

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

  const invoices_rows = invoices
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

  const bills_rows = bills
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

  const totalMatchedInflows = (matchedInflows as { amount: number }[]).reduce((s, x) => s + x.amount, 0)
  const totalMatchedOutflows = (matchedOutflows as { amount: number }[]).reduce((s, x) => s + x.amount, 0)
  const totalUnmatchedInflows = (unmatchedInflows as { amount: number }[]).reduce((s, x) => s + x.amount, 0)
  const totalUnmatchedOutflows = (unmatchedOutflows as { amount: number }[]).reduce((s, x) => s + x.amount, 0)

  return {
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
    total_unmapped_ar: Math.round(unmappedAr.reduce((s: number, u: { amount: number }) => s + u.amount, 0) * 100) / 100,
    total_fees_paid: Math.round(totalFeesPaid * 100) / 100,
    allocation_count: allocations.length,
  }
}
