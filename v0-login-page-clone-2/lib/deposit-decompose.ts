/**
 * Merchant deposit decomposition: tie "Merchant Bank Deposit" and similar
 * aggregated deposits to AR (Stripe/Shopify payouts → underlying invoices).
 *
 * For unmatched merchant deposits:
 * - Try to match Stripe payouts (stripe_entities entity_type='payout') by amount ±2% and date ±1 day
 * - If matched, create allocation to synthetic stripe_settlement_{payout_id} or to underlying invoices
 * - Fallback: return as unmapped for "Unmapped AR" pool in UI
 */

import { query, ensureStripeSchema } from "@/lib/db"
import { createAllocation } from "@/lib/allocation-persist"
import { getPaymentClass } from "@/lib/payment-class"

export type MerchantDepositMovement = {
  movement_id: string
  amount: number
  date: string
  counterparty: string | null
}

export type DecomposeResult = {
  decomposed: { movement_id: string; allocation_entity_id: string }[]
  unmapped: MerchantDepositMovement[]
}

const AMOUNT_TOLERANCE = 0.02 // ±2%
const DATE_TOLERANCE_MS = 24 * 60 * 60 * 1000 // ±1 day

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

/**
 * Try to match merchant deposits to Stripe payouts and create allocations.
 * Returns decomposed (allocated) and unmapped (could not decompose) lists.
 */
export async function decomposeMerchantDeposits(
  userId: string,
  deposits: MerchantDepositMovement[],
  allocatedMovementIds: Set<string>
): Promise<DecomposeResult> {
  const decomposed: { movement_id: string; allocation_entity_id: string }[] = []
  const unmapped: MerchantDepositMovement[] = []

  if (deposits.length === 0) return { decomposed, unmapped }

  let payoutRows: { entity_id: string; data: Record<string, unknown> }[] = []
  try {
    await ensureStripeSchema()
    const { rows } = await query<{ entity_id: string; data: Record<string, unknown> }>(
      `SELECT entity_id, data FROM stripe_entities
       WHERE user_id = $1 AND entity_type = 'payout'`,
      [userId]
    )
    payoutRows = rows
  } catch {
    // Stripe schema or table not available; skip payout matching
  }

  for (const dep of deposits) {
    if (allocatedMovementIds.has(dep.movement_id)) continue

    const depDate = new Date(dep.date).getTime()
    const depAmount = Math.abs(dep.amount)
    let matched: { entity_id: string; amount: number } | null = null

    for (const row of payoutRows) {
      const d = row.data as { amount?: number; arrival_date?: number; created?: number; status?: string }
      if (d.status !== "paid" && d.status !== "in_transit") continue
      const payoutAmount = (d.amount ?? 0) / 100 // Stripe amounts in cents
      const payoutDate = (d.arrival_date ?? d.created ?? 0) * 1000
      const amountOk = Math.abs(payoutAmount - depAmount) / Math.max(depAmount, 1) <= AMOUNT_TOLERANCE
      const dateOk = Math.abs(payoutDate - depDate) <= DATE_TOLERANCE_MS
      if (amountOk && dateOk) {
        matched = { entity_id: row.entity_id, amount: payoutAmount }
        break
      }
    }

    if (matched) {
      try {
        const syntheticInvoiceId = `stripe_settlement_${matched.entity_id}`
        await createAllocation(userId, dep.movement_id, "ar", syntheticInvoiceId, matched.amount, 0, matched.amount, 0.9, "stripe_payout_match")
        allocatedMovementIds.add(dep.movement_id)
        decomposed.push({ movement_id: dep.movement_id, allocation_entity_id: syntheticInvoiceId })
      } catch {
        unmapped.push(dep)
      }
    } else {
      unmapped.push(dep)
    }
  }

  return { decomposed, unmapped }
}
