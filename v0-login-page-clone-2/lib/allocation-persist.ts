/**
 * AR/AP allocation API — persisted as movement_attributions (canonical).
 * MovementAllocation shape retained for API/UI compatibility.
 */

import { query, ensureMovementsSchema } from "./db"
import type { CreateAllocationOpts, MatchMethod, MovementAllocation } from "./cash-allocation-types"
export type { AllocationTargetType, CreateAllocationOpts, MatchMethod, MovementAllocation } from "./cash-allocation-types"

import { confidenceFromScore } from "./confidence"
import {
  allocationTypeToComponent,
  attributionToMovementAllocation,
  createAttribution,
  matchMethodToAttributionSource,
} from "./attribution-persist"

export async function createAllocation(opts: CreateAllocationOpts): Promise<MovementAllocation>
export async function createAllocation(
  userId: string,
  movementId: string,
  entityType: "ar" | "ap",
  entityId: string,
  grossApplied: number,
  feeAmount: number,
  netApplied: number,
  confidence: number,
  matchMethod: MatchMethod,
): Promise<MovementAllocation>
export async function createAllocation(
  optsOrUserId: CreateAllocationOpts | string,
  movementId?: string,
  entityType?: "ar" | "ap",
  entityId?: string,
  grossApplied?: number,
  feeAmount?: number,
  netApplied?: number,
  confidence?: number,
  matchMethod?: MatchMethod,
): Promise<MovementAllocation> {
  let opts: CreateAllocationOpts
  if (typeof optsOrUserId === "object") {
    opts = optsOrUserId
  } else {
    opts = {
      userId: optsOrUserId,
      movementId: movementId!,
      entity_type: entityType!,
      entity_id: entityId!,
      gross_applied: grossApplied!,
      fee_amount: feeAmount!,
      net_applied: netApplied!,
      confidence: confidence!,
      match_method: matchMethod!,
    }
  }

  const reconcileAt = opts.reconcile_at ?? new Date()
  const metadata: Record<string, unknown> = {
    fee_amount: opts.fee_amount,
    match_method: opts.match_method,
    synthetic_invoice: opts.synthetic_invoice ?? false,
    reconcile_at: reconcileAt.toISOString(),
  }

  const row = await createAttribution({
    userId: opts.userId,
    movementId: opts.movementId,
    component_type: allocationTypeToComponent(opts.entity_type),
    entity_id: opts.entity_id,
    reference_id: opts.source_id ?? null,
    gross_amount: opts.gross_applied,
    net_amount: opts.net_applied,
    confidence: opts.confidence,
    source: matchMethodToAttributionSource(opts.match_method),
    metadata,
    confidenceEnvelope: opts.confidenceEnvelope ?? confidenceFromScore(opts.confidence, "probabilistic"),
  })

  return attributionToMovementAllocation(row)
}

export async function getAllocationsByMovement(movementId: string): Promise<MovementAllocation[]> {
  await ensureMovementsSchema()
  const { getAttributionsByMovement } = await import("./attribution-persist")
  const rows = await getAttributionsByMovement(movementId)
  return rows.map(attributionToMovementAllocation)
}

export async function getAllocationsByEntity(entityType: "ar" | "ap", entityId: string): Promise<MovementAllocation[]> {
  await ensureMovementsSchema()
  const { getAttributionsByEntity } = await import("./attribution-persist")
  const rows = await getAttributionsByEntity(entityType, entityId)
  return rows.map(attributionToMovementAllocation)
}

export async function getAllocationsForUser(userId: string): Promise<MovementAllocation[]> {
  await ensureMovementsSchema()
  const { getAttributionsForUser } = await import("./attribution-persist")
  const rows = await getAttributionsForUser(userId)
  return rows.map(attributionToMovementAllocation)
}

export async function getMovementIdsWithAllocations(userId: string): Promise<Set<string>> {
  await ensureMovementsSchema()
  const { rows } = await query<{ movement_id: string }>(
    `SELECT DISTINCT movement_id FROM movement_attributions WHERE user_id = $1`,
    [userId],
  )
  return new Set(rows.map((r) => r.movement_id))
}

export async function deleteAllocation(allocationId: string, userId: string): Promise<boolean> {
  await ensureMovementsSchema()
  const { deleteAttribution, deleteAttributionByLegacyAllocationId } = await import("./attribution-persist")
  if (await deleteAttribution(allocationId, userId)) return true
  if (await deleteAttributionByLegacyAllocationId(allocationId, userId)) return true
  const { rows } = await query<{ id: string }>(
    `DELETE FROM movement_allocations WHERE id = $1 AND user_id = $2 RETURNING id`,
    [allocationId, userId],
  )
  return rows.length > 0
}
