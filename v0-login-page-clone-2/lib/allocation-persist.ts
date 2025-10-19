/**
 * AR/AP to Payments allocation persistence.
 * Links movements to invoices (AR) or obligations (AP) with gross, fee, net.
 */

import { query, ensureMovementsSchema } from "./db"

export type MatchMethod = "exact" | "tolerance" | "llm_suggested" | "manual"

export type MovementAllocation = {
  id: string
  user_id: string
  movement_id: string
  entity_type: "ar" | "ap"
  entity_id: string
  gross_applied: number
  fee_amount: number
  net_applied: number
  confidence: number
  match_method: MatchMethod
  created_at: string
}

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
): Promise<MovementAllocation> {
  await ensureMovementsSchema()
  const { rows } = await query<MovementAllocation>(
    `INSERT INTO movement_allocations (user_id, movement_id, entity_type, entity_id, gross_applied, fee_amount, net_applied, confidence, match_method)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, user_id, movement_id, entity_type, entity_id, gross_applied::float, fee_amount::float, net_applied::float, confidence, match_method, created_at`,
    [userId, movementId, entityType, entityId, grossApplied, feeAmount, netApplied, confidence, matchMethod],
  )
  const row = rows[0]
  if (!row) throw new Error("Failed to create allocation")
  return {
    ...row,
    gross_applied: parseFloat(String(row.gross_applied)),
    fee_amount: parseFloat(String(row.fee_amount)),
    net_applied: parseFloat(String(row.net_applied)),
  }
}

export async function getAllocationsByMovement(movementId: string): Promise<MovementAllocation[]> {
  await ensureMovementsSchema()
  const { rows } = await query<MovementAllocation & { gross_applied: string; fee_amount: string; net_applied: string }>(
    `SELECT id, user_id, movement_id, entity_type, entity_id, gross_applied, fee_amount, net_applied, confidence, match_method, created_at
     FROM movement_allocations WHERE movement_id = $1`,
    [movementId],
  )
  return rows.map((r) => ({
    ...r,
    gross_applied: parseFloat(r.gross_applied),
    fee_amount: parseFloat(r.fee_amount),
    net_applied: parseFloat(r.net_applied),
  }))
}

export async function getAllocationsByEntity(entityType: "ar" | "ap", entityId: string): Promise<MovementAllocation[]> {
  await ensureMovementsSchema()
  const { rows } = await query<MovementAllocation & { gross_applied: string; fee_amount: string; net_applied: string }>(
    `SELECT id, user_id, movement_id, entity_type, entity_id, gross_applied, fee_amount, net_applied, confidence, match_method, created_at
     FROM movement_allocations WHERE entity_type = $1 AND entity_id = $2`,
    [entityType, entityId],
  )
  return rows.map((r) => ({
    ...r,
    gross_applied: parseFloat(r.gross_applied),
    fee_amount: parseFloat(r.fee_amount),
    net_applied: parseFloat(r.net_applied),
  }))
}

export async function getAllocationsForUser(userId: string): Promise<MovementAllocation[]> {
  await ensureMovementsSchema()
  const { rows } = await query<MovementAllocation & { gross_applied: string; fee_amount: string; net_applied: string }>(
    `SELECT id, user_id, movement_id, entity_type, entity_id, gross_applied, fee_amount, net_applied, confidence, match_method, created_at
     FROM movement_allocations WHERE user_id = $1`,
    [userId],
  )
  return rows.map((r) => ({
    ...r,
    gross_applied: parseFloat(r.gross_applied),
    fee_amount: parseFloat(r.fee_amount),
    net_applied: parseFloat(r.net_applied),
  }))
}

export async function getMovementIdsWithAllocations(userId: string): Promise<Set<string>> {
  await ensureMovementsSchema()
  const { rows } = await query<{ movement_id: string }>(
    `SELECT DISTINCT movement_id FROM movement_allocations WHERE user_id = $1`,
    [userId],
  )
  return new Set(rows.map((r) => r.movement_id))
}

export async function deleteAllocation(allocationId: string, userId: string): Promise<boolean> {
  await ensureMovementsSchema()
  const { rows } = await query<{ id: string }>(
    `DELETE FROM movement_allocations WHERE id = $1 AND user_id = $2 RETURNING id`,
    [allocationId, userId],
  )
  return rows.length > 0
}
