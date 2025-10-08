/**
 * Reconciliation job runner. Runs in background, writes result to reconciliation_cache.
 * Core matching is runAttributionEngine (movement_attributions).
 */

import { query, ensureMovementsSchema } from "@/lib/db"
import { isFeeAnomaly } from "@/lib/fee-anomaly"
import { resolveDisplayNames } from "@/lib/display-name-resolve"
import { getPaymentClass, isARAPOperating } from "@/lib/payment-class"
import { toEntityUriApBill } from "@/lib/entity-uri"
import { runAttributionEngine, AUTO_ALLOCATE_CONFIDENCE, type AttributionEngineOptions } from "@/lib/attribution-engine"
import { syncCashEventsForUser, refreshEntityCashProfilesFromAttributions } from "@/lib/cash-events-build"
import { computeAPStateFromBills } from "@/lib/state/ar-ap"

export type ReconciliationJobOptions = AttributionEngineOptions

export type CashExplanation = {
  fully_explained: number
  partially_explained: number
  unexplained: number
  explanation_pct: number
  ar_explained: number
  ap_explained: number
  fee_explained: number
}

export type ARSuggestion = {
  movement_id: string
  invoice_id: string
  customer_name: string
  confidence: number
  gross_applied: number
  fee_amount: number
  net_applied: number
}

export type APSuggestion = {
  movement_id: string
  obligation_id: string
  vendor_name: string
  confidence: number
  gross_applied: number
  fee_amount: number
  net_applied: number
}

export type ReconciliationResult = {
  invoices: unknown[]
  bills: unknown[]
  matched_inflows: unknown[]
  matched_outflows: unknown[]
  unmatched_inflows: unknown[]
  unmatched_outflows: unknown[]
  unmapped_ar: unknown[]
  ar_suggestions: ARSuggestion[]
  ap_suggestions: APSuggestion[]
  total_matched_inflows: number
  total_matched_outflows: number
  total_unmatched_inflows: number
  total_unmatched_outflows: number
  total_unmapped_ar: number
  total_fees_paid: number
  allocation_count: number
  cash_explanation: CashExplanation
}

export async function runReconciliationJob(
  userId: string,
  options: ReconciliationJobOptions | boolean = {}
): Promise<ReconciliationResult> {
  const opts = typeof options === "boolean" ? { arApOnly: options } : options
  const arApOnly = opts.arApOnly ?? false
  const merchantOnly = opts.merchantOnly ?? false

  await ensureMovementsSchema()

  const {
    allocatedMovementIds,
    allocationsRefreshed: allocations,
    merchantDeposits,
    movementRows,
    economicClassByMovement,
    invoices,
    bills,
    arSuggestions,
    apSuggestions,
  } = await runAttributionEngine(userId, { arApOnly, merchantOnly })

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
      const cn = (r.canonical_name ?? "").trim().toLowerCase()
      if (!/\b(test|jruby|jack\s*test)\b/.test(cn) && !/^[^\s]+@[^\s]+\.[^\s]+$/.test(cn)) {
        entityNames.set(r.id, r.canonical_name)
      }
    }
  }

  function isTestEntityName(name: string): boolean {
    const cn = (name ?? "").trim().toLowerCase()
    if (!cn) return true
    if (/\b(test|jruby|jack\s*test)\b/.test(cn)) return true
    if (/^[^\s]+@[^\s]+\.[^\s]+$/.test(cn)) return true
    return false
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

  const apAllocByEntityUri = new Map<string, { total: number; count: number }>()
  for (const a of allocations) {
    if (a.entity_type !== "ap" || !a.entity_id.startsWith("ap://bill/")) continue
    const cur = apAllocByEntityUri.get(a.entity_id) ?? { total: 0, count: 0 }
    cur.total += a.net_applied
    cur.count += 1
    apAllocByEntityUri.set(a.entity_id, cur)
  }

  const bills_rows = bills
    .filter((b) => !isTestEntityName(b.vendor_name))
    .map((b) => {
      const entityUri = b.entity_uri ?? toEntityUriApBill(b.source, b.bill_id)
      const alloc = apAllocByEntityUri.get(entityUri) ?? { total: 0, count: 0 }
      const remaining = Math.max(0, b.amount_due - alloc.total)
      return {
        bill_id: b.bill_id,
        entity_uri: entityUri,
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

  const allocsByMovement = new Map<string, typeof allocations>()
  for (const a of allocations) {
    if (!allocsByMovement.has(a.movement_id)) allocsByMovement.set(a.movement_id, [])
    allocsByMovement.get(a.movement_id)!.push(a)
  }
  const EPSILON = 0.01
  /** True when allocations sum to movement within 1% / $0.01 (strict). */
  function amountsReconcileToMovement(amount: number, allocs: typeof allocations): boolean {
    const allocSum = allocs.reduce((s, a) => s + a.net_applied, 0)
    const diff = Math.abs(amount - Math.abs(allocSum))
    return diff <= EPSILON * amount || diff <= EPSILON
  }
  /** Same bar as AR/AP auto-allocate: if every line was accepted at ≥78%, count as fully explained even if float/rounding leaves a small residual vs strict epsilon. */
  function allocsMeetAutoAllocateConfidence(allocs: typeof allocations): boolean {
    if (allocs.length === 0) return false
    return allocs.every((a) => (a.confidence ?? 0) >= AUTO_ALLOCATE_CONFIDENCE)
  }
  let fullyExplained = 0
  let partiallyExplained = 0
  let unexplained = 0
  let arExplained = 0
  let apExplained = 0
  let feeExplained = 0
  for (const m of movementRows) {
    const amount = Math.abs(parseFloat(String(m.amount)))
    const allocs = allocsByMovement.get(m.id) ?? []
    const strictOk = amountsReconcileToMovement(amount, allocs)
    const confidenceAligned = allocsMeetAutoAllocateConfidence(allocs)
    if (allocs.length === 0) {
      unexplained += amount
    } else if (strictOk || confidenceAligned) {
      fullyExplained += amount
      for (const a of allocs) {
        if (a.entity_type === "ar") arExplained += a.net_applied
        else if (a.entity_type === "ap") apExplained += a.net_applied
        else if (a.entity_type === "fee") feeExplained += Math.abs(a.net_applied)
      }
    } else {
      partiallyExplained += amount
    }
  }
  const totalCash = fullyExplained + partiallyExplained + unexplained
  const cashExplanation: CashExplanation = {
    fully_explained: Math.round(fullyExplained * 100) / 100,
    partially_explained: Math.round(partiallyExplained * 100) / 100,
    unexplained: Math.round(unexplained * 100) / 100,
    explanation_pct: totalCash > 0 ? Math.round((fullyExplained / totalCash) * 1000) / 10 : 100,
    ar_explained: Math.round(arExplained * 100) / 100,
    ap_explained: Math.round(apExplained * 100) / 100,
    fee_explained: Math.round(feeExplained * 100) / 100,
  }

  try {
    await syncCashEventsForUser(userId, invoices, computeAPStateFromBills(bills))
    await refreshEntityCashProfilesFromAttributions(userId)
  } catch (err) {
    console.warn("[reconciliation-run] cash_events / profile refresh:", err instanceof Error ? err.message : err)
  }

  return {
    invoices: invoices_rows,
    bills: bills_rows,
    matched_inflows: matchedInflows,
    matched_outflows: matchedOutflows,
    unmatched_inflows: unmatchedInflows,
    unmatched_outflows: unmatchedOutflows,
    unmapped_ar: unmappedAr,
    ar_suggestions: arSuggestions as ARSuggestion[],
    ap_suggestions: apSuggestions as APSuggestion[],
    total_matched_inflows: Math.round(totalMatchedInflows * 100) / 100,
    total_matched_outflows: Math.round(totalMatchedOutflows * 100) / 100,
    total_unmatched_inflows: Math.round(totalUnmatchedInflows * 100) / 100,
    total_unmatched_outflows: Math.round(totalUnmatchedOutflows * 100) / 100,
    total_unmapped_ar: Math.round(unmappedAr.reduce((s: number, u: { amount: number }) => s + u.amount, 0) * 100) / 100,
    total_fees_paid: Math.round(totalFeesPaid * 100) / 100,
    allocation_count: allocations.length,
    cash_explanation: cashExplanation,
  }
}
