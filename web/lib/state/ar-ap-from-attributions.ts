/**
 * Derive collection/payment rollups from movement attributions (canonical cash application).
 */

import type { MovementAllocation } from "@/lib/cash-allocation-types"
import type { OutstandingInvoice } from "./types"
import { toEntityUriAr } from "@/lib/entity-uri"

export type AllocationRollupEntry = { movement_id: string; gross: number; fee: number; net: number }

/** Sum net applied to AR invoice URIs (cash applied to receivables). */
export function aggregateArAttributionsByUri(allocations: MovementAllocation[]): Map<string, AllocationRollupEntry[]> {
  const map = new Map<string, AllocationRollupEntry[]>()
  for (const a of allocations) {
    if (a.entity_type !== "ar") continue
    const list = map.get(a.entity_id) ?? []
    list.push({
      movement_id: a.movement_id,
      gross: a.gross_applied,
      fee: a.fee_amount,
      net: a.net_applied,
    })
    map.set(a.entity_id, list)
  }
  return map
}

/** Sum net applied to AP obligation URIs. */
export function aggregateApAttributionsByUri(allocations: MovementAllocation[]): Map<string, AllocationRollupEntry[]> {
  const map = new Map<string, AllocationRollupEntry[]>()
  for (const a of allocations) {
    if (a.entity_type !== "ap") continue
    const list = map.get(a.entity_id) ?? []
    list.push({
      movement_id: a.movement_id,
      gross: a.gross_applied,
      fee: a.fee_amount,
      net: a.net_applied,
    })
    map.set(a.entity_id, list)
  }
  return map
}

export function enrichInvoiceWithAttributions(
  inv: OutstandingInvoice,
  arByUri: Map<string, AllocationRollupEntry[]>,
): OutstandingInvoice & {
  allocations: AllocationRollupEntry[]
  amount_collected: number
  amount_remaining: number
} {
  const entityUri = inv.entity_uri ?? toEntityUriAr(inv.source, inv.invoice_id)
  const allocs = arByUri.get(entityUri) ?? []
  const amountCollected = allocs.reduce((s, c) => s + c.net, 0)
  const amountRemaining = Math.max(0, inv.amount_due - amountCollected)
  return {
    ...inv,
    allocations: allocs,
    amount_collected: Math.round(amountCollected * 100) / 100,
    amount_remaining: Math.round(amountRemaining * 100) / 100,
  }
}

export type ObligationLike = {
  obligation_id: string
  amount_due: number
  [k: string]: unknown
}

export function enrichObligationWithAttributions<T extends ObligationLike>(
  ob: T,
  apByUri: Map<string, AllocationRollupEntry[]>,
): T & { allocations: AllocationRollupEntry[]; amount_paid: number; amount_remaining: number } {
  const allocs = apByUri.get(ob.obligation_id) ?? []
  const amountPaid = allocs.reduce((s, c) => s + c.net, 0)
  const amountRemaining = Math.max(0, ob.amount_due - amountPaid)
  return {
    ...ob,
    allocations: allocs,
    amount_paid: Math.round(amountPaid * 100) / 100,
    amount_remaining: Math.round(amountRemaining * 100) / 100,
  }
}
