/**
 * Attribution engine: per-movement passes (AR → AP → settlement/merchant → transfer hint → unknown).
 * Persists high-confidence matches via createAllocation (movement_attributions).
 */

import { query } from "@/lib/db"
import { getAllocationsForUser, createAllocation } from "@/lib/allocation-persist"
import { matchARPayment, type InflowPayment } from "@/lib/ar-payment-match"
import { matchAPPayment, type PaymentInput } from "@/lib/ap-llm-match"
import { fetchInvoicesForReconciliation } from "@/lib/invoices-fetch"
import { fetchOutstandingBills } from "@/lib/bills-fetch"
import { computeAPStateFromBills } from "@/lib/state/ar-ap"
import { filterMerchantDeposits, runMerchantDepositPipeline } from "@/lib/merchant-deposit-pipeline"
import { toEntityUriAr } from "@/lib/entity-uri"
import { computeEntityPaymentProfiles } from "@/lib/entity-payment-profiles"

export type AttributionEngineOptions = {
  arApOnly?: boolean
  merchantOnly?: boolean
}

export const AUTO_ALLOCATE_CONFIDENCE = 0.78
export const SUGGEST_CONFIDENCE_MIN = 0.65

type MovementRow = {
  id: string
  direction: string
  amount: string
  date: string
  counterparty: string | null
  counterparty_entity_id: string | null
  raw_description: string | null
}

function isTestEntityName(name: string): boolean {
  const cn = (name ?? "").trim().toLowerCase()
  if (!cn) return true
  if (/\b(test|jruby|jack\s*test)\b/.test(cn)) return true
  if (/^[^\s]+@[^\s]+\.[^\s]+$/.test(cn)) return true
  return false
}

export type AttributionEngineResult = {
  allocatedMovementIds: Set<string>
  allocationsRefreshed: Awaited<ReturnType<typeof getAllocationsForUser>>
  merchantDeposits: { movement_id: string; amount: number; date: string; counterparty: string | null }[]
  movementRows: MovementRow[]
  economicClassByMovement: Map<string, string>
  invoices: Awaited<ReturnType<typeof fetchInvoicesForReconciliation>>
  bills: Awaited<ReturnType<typeof fetchOutstandingBills>>
  arSuggestions: AttributionARSuggestion[]
  apSuggestions: AttributionAPSuggestion[]
}

export type AttributionARSuggestion = {
  movement_id: string
  invoice_id: string
  customer_name: string
  confidence: number
  gross_applied: number
  fee_amount: number
  net_applied: number
}

export type AttributionAPSuggestion = {
  movement_id: string
  obligation_id: string
  vendor_name: string
  confidence: number
  gross_applied: number
  fee_amount: number
  net_applied: number
}

export async function runAttributionEngine(
  userId: string,
  options: AttributionEngineOptions = {},
): Promise<AttributionEngineResult> {
  const arApOnly = options.arApOnly ?? false
  const merchantOnly = options.merchantOnly ?? false

  let allocations = await getAllocationsForUser(userId)
  const allocatedMovementIds = new Set(allocations.map((a) => a.movement_id))

  const { rows: movementRows } = await query<MovementRow>(
    `SELECT id, direction, amount::float, date, counterparty, counterparty_entity_id, raw_description FROM movements
     WHERE user_id = $1 AND duplicate_of IS NULL ORDER BY date DESC`,
    [userId],
  )

  const { rows: tagRows } = await query<{ movement_id: string; economic_class: string }>(
    `SELECT movement_id, economic_class FROM movement_tags
     WHERE movement_id IN (SELECT id FROM movements WHERE user_id = $1 AND duplicate_of IS NULL)`,
    [userId],
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

  const arSuggestions: AttributionARSuggestion[] = []
  const apSuggestions: AttributionAPSuggestion[] = []

  if (!merchantOnly) {
    // Pass 1: AR attribution (inflows)
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
        } catch {
          /* skip */
        }
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

    // Pass 2: AP attribution (outflows)
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
          } catch {
            /* skip */
          }
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
      economicClassByMovement,
    )
    if (merchantDeposits.length > 0) {
      const { decomposed } = await runMerchantDepositPipeline(userId, merchantDeposits, economicClassByMovement, allocatedMovementIds)
      if (decomposed.length > 0) {
        allocations = await getAllocationsForUser(userId)
        for (const d of decomposed) allocatedMovementIds.add(d.movement_id)
      }
    }
  }

  return {
    allocatedMovementIds,
    allocationsRefreshed: allocations,
    merchantDeposits,
    movementRows,
    economicClassByMovement,
    invoices,
    bills,
    arSuggestions,
    apSuggestions,
  }
}
