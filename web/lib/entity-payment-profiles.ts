/**
 * Entity payment memory: per-entity payment behavior for allocation scoring.
 * Used to boost confidence when amount ratio matches entity's typical pattern.
 */

import { ensureMovementsSchema } from "./db"
import { getAllocationsForUser } from "./allocation-persist"

export type EntityPaymentProfile = {
  entity_id: string
  avg_payment_ratio: number
  avg_delay_days: number
  payment_count: number
  variance: number
}

/**
 * Compute payment ratio (net/gross) from allocation history.
 * Rebuild profiles from allocations + invoices for AR entities.
 */
export async function computeEntityPaymentProfiles(userId: string): Promise<Map<string, EntityPaymentProfile>> {
  await ensureMovementsSchema()
  const allocations = await getAllocationsForUser(userId)

  const byEntity = new Map<string, { ratios: number[]; delays: number[] }>()
  for (const a of allocations) {
    if (a.entity_type !== "ar" || a.gross_applied <= 0) continue
    const ratio = a.net_applied / a.gross_applied
    const entityKey = a.entity_id
    if (!byEntity.has(entityKey)) byEntity.set(entityKey, { ratios: [], delays: [] })
    const entry = byEntity.get(entityKey)!
    entry.ratios.push(ratio)
    // Delay: would need movement date vs invoice due date - skip for now
    entry.delays.push(0)
  }

  const profiles = new Map<string, EntityPaymentProfile>()
  for (const [entityKey, { ratios }] of byEntity) {
    if (ratios.length < 2) continue
    const avg = ratios.reduce((s, r) => s + r, 0) / ratios.length
    const variance = ratios.reduce((s, r) => s + (r - avg) ** 2, 0) / ratios.length
    profiles.set(entityKey, {
      entity_id: entityKey,
      avg_payment_ratio: Math.round(avg * 1000) / 1000,
      avg_delay_days: 0,
      payment_count: ratios.length,
      variance: Math.round(variance * 1000000) / 1000000,
    })
  }
  return profiles
}

/**
 * Get entity's typical payment ratio for confidence boost.
 * Returns 1 if no profile (neutral).
 */
export function getEntityPaymentRatio(profiles: Map<string, EntityPaymentProfile>, entityUri: string): number {
  return profiles.get(entityUri)?.avg_payment_ratio ?? 1
}
