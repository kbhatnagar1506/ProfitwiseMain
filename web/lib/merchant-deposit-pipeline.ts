/**
 * Merchant deposit pipeline: bank → explain.
 *
 * Steps:
 * 1. Detect processor (Stripe, Shopify, etc.) from movement
 * 2. Match payout object (amount ±2%, date ±1 day)
 * 3. Expand: fetch payout details, balance_transactions for fees
 * 4. Map to AR: create synthetic allocation
 * 5. Extract fees: create fee allocation when payout has fees
 */

import { query, ensureStripeSchema } from "@/lib/db"
import { createAllocation } from "@/lib/allocation-persist"
import { getPaymentClass } from "@/lib/payment-class"
import { toEntityUriArSynthetic } from "@/lib/entity-uri"

export type MerchantDepositMovement = {
  movement_id: string
  amount: number
  date: string
  counterparty: string | null
}

export type PipelineResult = {
  decomposed: { movement_id: string; allocation_entity_id: string }[]
  unmapped: MerchantDepositMovement[]
}

const AMOUNT_TOLERANCE = 0.02
const DATE_TOLERANCE_MS = 24 * 60 * 60 * 1000

/**
 * Identify merchant deposit movements from unmatched inflows.
 * Uses economic_class to determine processor_payout / settlement_in.
 */
export function filterMerchantDeposits(
  movements: { movement_id: string; amount: number; date: string; counterparty: string | null; payment_class?: string }[],
  economicClassByMovement: Map<string, string>
): MerchantDepositMovement[] {
  const out: MerchantDepositMovement[] = []
  for (const m of movements) {
    const ec = economicClassByMovement.get(m.movement_id) ?? "unknown"
    const pc = m.payment_class ?? getPaymentClass(ec)
    if (pc === "PROCESSOR_SETTLEMENT") {
      out.push({
        movement_id: m.movement_id,
        amount: m.amount,
        date: m.date,
        counterparty: m.counterparty,
      })
    }
  }
  return out
}

/** Step 1: Detect processor from economic_class / payment_class */
export function detectProcessor(
  ec: string,
  paymentClass?: string
): "stripe" | "shopify" | "processor" | null {
  const pc = paymentClass ?? getPaymentClass(ec)
  if (pc !== "PROCESSOR_SETTLEMENT") return null
  if (ec === "shopify_payout") return "shopify"
  return "stripe"
}

/** Step 2: Match movement to payout */
function matchPayout(
  dep: MerchantDepositMovement,
  payoutRows: { entity_id: string; data: Record<string, unknown> }[]
): { entity_id: string; amount: number; fee?: number } | null {
  const depDate = new Date(dep.date).getTime()
  const depAmount = Math.abs(dep.amount)
  for (const row of payoutRows) {
    const d = row.data as { amount?: number; arrival_date?: number; created?: number; status?: string; fee?: number }
    if (d.status !== "paid" && d.status !== "in_transit") continue
    const payoutAmount = (d.amount ?? 0) / 100
    const payoutDate = (d.arrival_date ?? d.created ?? 0) * 1000
    const amountOk = Math.abs(payoutAmount - depAmount) / Math.max(depAmount, 1) <= AMOUNT_TOLERANCE
    const dateOk = Math.abs(payoutDate - depDate) <= DATE_TOLERANCE_MS
    if (amountOk && dateOk) {
      const fee = d.fee != null ? (d.fee as number) / 100 : undefined
      return { entity_id: row.entity_id, amount: payoutAmount, fee }
    }
  }
  return null
}

/** Step 3–5: Create allocations (AR + fee if applicable) */
export async function runMerchantDepositPipeline(
  userId: string,
  deposits: MerchantDepositMovement[],
  economicClassByMovement: Map<string, string>,
  allocatedMovementIds: Set<string>
): Promise<PipelineResult> {
  const decomposed: { movement_id: string; allocation_entity_id: string }[] = []
  const unmapped: MerchantDepositMovement[] = []

  if (deposits.length === 0) return { decomposed, unmapped }

  let payoutRows: { entity_id: string; data: Record<string, unknown> }[] = []
  try {
    await ensureStripeSchema()
    const { rows } = await query<{ entity_id: string; data: Record<string, unknown> }>(
      `SELECT entity_id, data FROM stripe_entities WHERE user_id = $1 AND entity_type = 'payout'`,
      [userId]
    )
    payoutRows = rows
  } catch {
    /* Stripe not available */
  }

  for (const dep of deposits) {
    if (allocatedMovementIds.has(dep.movement_id)) continue

    const ec = economicClassByMovement.get(dep.movement_id) ?? "unknown"
    const processor = detectProcessor(ec)
    if (!processor || processor !== "stripe") {
      unmapped.push(dep)
      continue
    }

    const matched = matchPayout(dep, payoutRows)
    if (!matched) {
      unmapped.push(dep)
      continue
    }

    try {
      const entityUri = toEntityUriArSynthetic(matched.entity_id)
      const feeAmount = matched.fee ?? 0
      const gross = matched.amount + feeAmount

      await createAllocation({
        userId,
        movementId: dep.movement_id,
        entity_type: "ar",
        entity_id: entityUri,
        gross_applied: gross > 0 ? gross : matched.amount,
        fee_amount: 0,
        net_applied: matched.amount,
        confidence: 0.9,
        match_method: "stripe_payout_match",
        synthetic_invoice: true,
        reconcile_at: new Date(),
      })

      if (feeAmount > 0) {
        await createAllocation({
          userId,
          movementId: dep.movement_id,
          entity_type: "fee",
          entity_id: "fee://stripe",
          gross_applied: 0,
          fee_amount: feeAmount,
          net_applied: -feeAmount,
          confidence: 0.9,
          match_method: "stripe_payout_match",
          reconcile_at: new Date(),
        })
      }

      allocatedMovementIds.add(dep.movement_id)
      decomposed.push({ movement_id: dep.movement_id, allocation_entity_id: entityUri })
    } catch {
      unmapped.push(dep)
    }
  }

  return { decomposed, unmapped }
}
