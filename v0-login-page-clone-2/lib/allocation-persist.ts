/**
 * AR/AP to Payments allocation persistence.
 * Links movements to invoices (AR) or obligations (AP) with gross, fee, net.
 *
 * Semantics: AR net_applied = gross (invoice satisfied); fee allocation net_applied = -fee (deduction).
 * Sum of allocations net_applied = movement amount.
 */

import { query, ensureMovementsSchema } from "./db"

export type MatchMethod = "exact" | "tolerance" | "llm_suggested" | "manual" | "stripe_payout_match"

export type AllocationTargetType = "ar" | "ap" | "fee" | "transfer" | "unknown"

export type MovementAllocation = {
  id: string
  user_id: string
  movement_id: string
  entity_type: AllocationTargetType
  entity_id: string
  gross_applied: number
  fee_amount: number
  net_applied: number
  confidence: number
  match_method: MatchMethod
  created_at: string
  source_id?: string | null
  synthetic_invoice?: boolean
  reconcile_at?: string | null
}

export type CreateAllocationOpts = {
  userId: string
  movementId: string
  entity_type: AllocationTargetType
  entity_id: string
  gross_applied: number
  fee_amount: number
  net_applied: number
  confidence: number
  match_method: MatchMethod
  source_id?: string | null
  synthetic_invoice?: boolean
  reconcile_at?: Date
}

function normalizeAllocationRow<T extends { gross_applied?: unknown; fee_amount?: unknown; net_applied?: unknown }>(
  row: T
): T & { gross_applied: number; fee_amount: number; net_applied: number } {
  return {
    ...row,
    gross_applied: parseFloat(String(row.gross_applied)),
    fee_amount: parseFloat(String(row.fee_amount)),
    net_applied: parseFloat(String(row.net_applied)),
  } as T & { gross_applied: number; fee_amount: number; net_applied: number }
}

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

  await ensureMovementsSchema()
  const reconcileAt = opts.reconcile_at ?? new Date()
  const { rows } = await query<MovementAllocation & { gross_applied: string; fee_amount: string; net_applied: string }>(
    `INSERT INTO movement_allocations (user_id, movement_id, entity_type, entity_id, gross_applied, fee_amount, net_applied, confidence, match_method, source_id, synthetic_invoice, reconcile_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id, user_id, movement_id, entity_type, entity_id, gross_applied, fee_amount, net_applied, confidence, match_method, created_at, source_id, synthetic_invoice, reconcile_at`,
    [
      opts.userId,
      opts.movementId,
      opts.entity_type,
      opts.entity_id,
      opts.gross_applied,
      opts.fee_amount,
      opts.net_applied,
      opts.confidence,
      opts.match_method,
      opts.source_id ?? null,
      opts.synthetic_invoice ?? false,
      reconcileAt,
    ],
  )
  const row = rows[0]
  if (!row) throw new Error("Failed to create allocation")
  return normalizeAllocationRow(row)
}

export async function getAllocationsByMovement(movementId: string): Promise<MovementAllocation[]> {
  await ensureMovementsSchema()
  const { rows } = await query<MovementAllocation & { gross_applied: string; fee_amount: string; net_applied: string }>(
    `SELECT id, user_id, movement_id, entity_type, entity_id, gross_applied, fee_amount, net_applied, confidence, match_method, created_at, source_id, synthetic_invoice, reconcile_at
     FROM movement_allocations WHERE movement_id = $1`,
    [movementId],
  )
  return rows.map((r) => normalizeAllocationRow(r))
}

export async function getAllocationsByEntity(entityType: "ar" | "ap", entityId: string): Promise<MovementAllocation[]> {
  await ensureMovementsSchema()
  const { rows } = await query<MovementAllocation & { gross_applied: string; fee_amount: string; net_applied: string }>(
    `SELECT id, user_id, movement_id, entity_type, entity_id, gross_applied, fee_amount, net_applied, confidence, match_method, created_at, source_id, synthetic_invoice, reconcile_at
     FROM movement_allocations WHERE entity_type = $1 AND entity_id = $2`,
    [entityType, entityId],
  )
  return rows.map((r) => normalizeAllocationRow(r))
}

export async function getAllocationsForUser(userId: string): Promise<MovementAllocation[]> {
  await ensureMovementsSchema()
  const { rows } = await query<MovementAllocation & { gross_applied: string; fee_amount: string; net_applied: string }>(
    `SELECT id, user_id, movement_id, entity_type, entity_id, gross_applied, fee_amount, net_applied, confidence, match_method, created_at, source_id, synthetic_invoice, reconcile_at
     FROM movement_allocations WHERE user_id = $1`,
    [userId],
  )
  return rows.map((r) => normalizeAllocationRow(r))
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
