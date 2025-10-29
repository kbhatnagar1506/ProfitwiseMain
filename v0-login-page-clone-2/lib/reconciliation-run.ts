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
import { filterMerchantDeposits, runMerchantDepositPipeline } from "@/lib/merchant-deposit-pipeline"
import { toEntityUriAr, toEntityUriApBill } from "@/lib/entity-uri"
import { computeEntityPaymentProfiles } from "@/lib/entity-payment-profiles"

const AUTO_ALLOCATE_CONFIDENCE = 0.78
const SUGGEST_CONFIDENCE_MIN = 0.65

export type ReconciliationJobOptions = {
  arApOnly?: boolean
  merchantOnly?: boolean
}

function isTestEntityName(name: string): boolean {
  const cn = (name ?? "").trim().toLowerCase()
  if (!cn) return true
  if (/\b(test|jruby|jack\s*test)\b/.test(cn)) return true
  if (/^[^\s]+@[^\s]+\.[^\s]+$/.test(cn)) return true
  return false
}

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

  const entityProfiles = await computeEntityPaymentProfiles(userId)

  const arSuggestions: ARSuggestion[] = []
  const apSuggestions: APSuggestion[] = []

  if (!merchantOnly) {
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
      const match = matchARPayment(payment, invoices, entityProfiles)
      if (match && match.confidence >= AUTO_ALLOCATE_CONFIDENCE) {
        try {
          const invoice = invoices.find((i) => i.invoice_id === match.invoice_id)!
          const entityUri = invoice.entity_uri ?? toEntityUriAr(invoice.source, invoice.invoice_id)
          await createAllocation({
            userId,
            movementId: m.id,
            entity_type: "ar",
            entity_id: entityUri,
            gross_applied: match.gross_applied,
            fee_amount: 0,
            net_applied: match.gross_applied,
            confidence: match.confidence,
            match_method: match.match_method,
            source_id: `${invoice.source}/${invoice.invoice_id}`,
            reconcile_at: new Date(),
          })
          // AR net_applied = gross (invoice satisfied); fee allocation net_applied = -fee (deduction). Sum = movement amount.
          if (match.fee_amount > 0) {
            const processor = invoice.source === "stripe" ? "stripe" : "processor"
            await createAllocation({
              userId,
              movementId: m.id,
              entity_type: "fee",
              entity_id: `fee://${processor}`,
              gross_applied: 0,
              fee_amount: match.fee_amount,
              net_applied: -match.fee_amount,
              confidence: match.confidence,
              match_method: match.match_method,
              reconcile_at: new Date(),
            })
          }
          allocatedMovementIds.add(m.id)
        } catch { /* skip */ }
      } else if (match && match.confidence >= SUGGEST_CONFIDENCE_MIN && match.confidence < AUTO_ALLOCATE_CONFIDENCE) {
        const invoice = invoices.find((i) => i.invoice_id === match.invoice_id)!
        arSuggestions.push({
          movement_id: m.id,
          invoice_id: match.invoice_id,
          customer_name: invoice.customer_name,
          confidence: match.confidence,
          gross_applied: match.gross_applied,
          fee_amount: match.fee_amount,
          net_applied: match.net_applied,
        })
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
        if (match && match.confidence >= AUTO_ALLOCATE_CONFIDENCE) {
          try {
            await createAllocation({
              userId,
              movementId: m.id,
              entity_type: "ap",
              entity_id: match.obligation_id,
              gross_applied: match.gross_applied,
              fee_amount: match.fee_amount,
              net_applied: match.net_applied,
              confidence: match.confidence,
              match_method: match.match_method,
              reconcile_at: new Date(),
            })
            allocatedMovementIds.add(m.id)
          } catch { /* skip */ }
        } else if (match && match.confidence >= SUGGEST_CONFIDENCE_MIN && match.confidence < AUTO_ALLOCATE_CONFIDENCE) {
          const ob = obligations.find((o) => o.obligation_id === match.obligation_id)!
          apSuggestions.push({
            movement_id: m.id,
            obligation_id: match.obligation_id,
            vendor_name: ob.vendor_name,
            confidence: match.confidence,
            gross_applied: match.gross_applied,
            fee_amount: match.fee_amount,
            net_applied: match.net_applied,
          })
        }
      }
    }

    allocations = await getAllocationsForUser(userId)
  }

  let merchantDeposits: { movement_id: string; amount: number; date: string; counterparty: string | null }[] = []
  if (!arApOnly) {
    const stillUnmatchedInflows = movementRows.filter((m) => m.direction === "inflow" && !allocatedMovementIds.has(m.id))
    merchantDeposits = filterMerchantDeposits(
      stillUnmatchedInflows.map((m) => ({
        movement_id: m.id,
        amount: parseFloat(String(m.amount)),
        date: m.date,
        counterparty: m.counterparty,
      })),
      economicClassByMovement
    )
    if (merchantDeposits.length > 0) {
      const { decomposed } = await runMerchantDepositPipeline(userId, merchantDeposits, economicClassByMovement, allocatedMovementIds)
      if (decomposed.length > 0) {
        allocations = await getAllocationsForUser(userId)
        for (const d of decomposed) allocatedMovementIds.add(d.movement_id)
      }
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
  let fullyExplained = 0
  let partiallyExplained = 0
  let unexplained = 0
  let arExplained = 0
  let apExplained = 0
  let feeExplained = 0
  for (const m of movementRows) {
    const amount = Math.abs(parseFloat(String(m.amount)))
    const allocs = allocsByMovement.get(m.id) ?? []
    const allocSum = allocs.reduce((s, a) => s + a.net_applied, 0)
    const diff = Math.abs(amount - Math.abs(allocSum))
    if (allocs.length === 0) {
      unexplained += amount
    } else if (diff <= EPSILON * amount || diff <= EPSILON) {
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

  return {
    invoices: invoices_rows,
    bills: bills_rows,
    matched_inflows: matchedInflows,
    matched_outflows: matchedOutflows,
    unmatched_inflows: unmatchedInflows,
    unmatched_outflows: unmatchedOutflows,
    unmapped_ar: unmappedAr,
    ar_suggestions: arSuggestions,
    ap_suggestions: apSuggestions,
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
