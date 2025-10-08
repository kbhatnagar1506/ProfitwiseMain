/**
 * Movement attributions: canonical decomposition of each movement (AR/AP/fee/transfer/settlement/unknown).
 */

import { query, ensureMovementsSchema } from "./db"
import type { AllocationTargetType, MatchMethod, MovementAllocation } from "./cash-allocation-types"
import { confidenceFromScore, serializeConfidenceEnvelope, type ConfidenceEnvelope } from "./confidence"

export type AttributionSource = "rule" | "model" | "llm" | "user"

export type ComponentType = "ar" | "ap" | "fee" | "transfer" | "settlement" | "unknown"

export type MovementAttributionRow = {
  id: string
  user_id: string
  movement_id: string
  component_type: ComponentType
  entity_id: string
  reference_id: string | null
  gross_amount: number
  net_amount: number
  confidence: number
  source: AttributionSource
  metadata: Record<string, unknown>
  confidence_detail: unknown | null
  migrated_from_allocation_id: string | null
  created_at: string
}

export type CreateAttributionOpts = {
  userId: string
  movementId: string
  component_type: ComponentType
  entity_id: string
  reference_id?: string | null
  gross_amount: number
  net_amount: number
  confidence: number
  source: AttributionSource
  metadata?: Record<string, unknown>
  confidenceEnvelope?: ConfidenceEnvelope | null
  migrated_from_allocation_id?: string | null
}

export function matchMethodToAttributionSource(method: MatchMethod): AttributionSource {
  if (method === "llm_suggested") return "llm"
  if (method === "manual") return "user"
  return "rule"
}

/** Map legacy allocation entity_type to component_type (1:1). */
export function allocationTypeToComponent(t: AllocationTargetType): ComponentType {
  return t as ComponentType
}

function normalizeAttributionRow(
  row: MovementAttributionRow & { gross_amount: unknown; net_amount: unknown; metadata?: unknown },
): MovementAttributionRow {
  return {
    ...row,
    gross_amount: parseFloat(String(row.gross_amount)),
    net_amount: parseFloat(String(row.net_amount)),
    metadata: (row.metadata && typeof row.metadata === "object" ? row.metadata : {}) as Record<string, unknown>,
  }
}

/** Convert persisted attribution to MovementAllocation for API/UI compatibility. */
export function attributionToMovementAllocation(row: MovementAttributionRow): MovementAllocation {
  const md = row.metadata ?? {}
  const fee_amount = typeof md.fee_amount === "number" ? md.fee_amount : parseFloat(String(md.fee_amount ?? 0)) || 0
  const match_method = (md.match_method as MatchMethod) ?? "tolerance"
  const synthetic_invoice = Boolean(md.synthetic_invoice)
  const reconcile_at = typeof md.reconcile_at === "string" ? md.reconcile_at : null

  return {
    id: row.id,
    user_id: row.user_id,
    movement_id: row.movement_id,
    entity_type: row.component_type as AllocationTargetType,
    entity_id: row.entity_id,
    gross_applied: row.gross_amount,
    fee_amount,
    net_applied: row.net_amount,
    confidence: row.confidence,
    match_method,
    created_at: row.created_at,
    source_id: row.reference_id ?? undefined,
    synthetic_invoice,
    reconcile_at,
  }
}

export async function createAttribution(opts: CreateAttributionOpts): Promise<MovementAttributionRow> {
  await ensureMovementsSchema()
  const metadata = { ...opts.metadata }
  const confDetail = opts.confidenceEnvelope
    ? serializeConfidenceEnvelope(opts.confidenceEnvelope)
    : opts.confidence
      ? serializeConfidenceEnvelope(confidenceFromScore(opts.confidence))
      : null

  const { rows } = await query<
    MovementAttributionRow & { gross_amount: string; net_amount: string }
  >(
    `INSERT INTO movement_attributions (
      user_id, movement_id, component_type, entity_id, reference_id,
      gross_amount, net_amount, confidence, source, metadata, confidence_detail, migrated_from_allocation_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12)
    RETURNING id, user_id, movement_id, component_type, entity_id, reference_id,
      gross_amount, net_amount, confidence, source, metadata, confidence_detail, migrated_from_allocation_id, created_at`,
    [
      opts.userId,
      opts.movementId,
      opts.component_type,
      opts.entity_id,
      opts.reference_id ?? null,
      opts.gross_amount,
      opts.net_amount,
      opts.confidence,
      opts.source,
      JSON.stringify(metadata),
      confDetail ? JSON.stringify(confDetail) : null,
      opts.migrated_from_allocation_id ?? null,
    ],
  )
  const row = rows[0]
  if (!row) throw new Error("Failed to create attribution")
  return normalizeAttributionRow(row as MovementAttributionRow)
}

export async function getAttributionsByMovement(movementId: string): Promise<MovementAttributionRow[]> {
  await ensureMovementsSchema()
  const { rows } = await query<MovementAttributionRow & { gross_amount: string; net_amount: string }>(
    `SELECT id, user_id, movement_id, component_type, entity_id, reference_id,
            gross_amount, net_amount, confidence, source, metadata, confidence_detail, migrated_from_allocation_id, created_at
     FROM movement_attributions WHERE movement_id = $1 ORDER BY created_at ASC`,
    [movementId],
  )
  return rows.map((r) => normalizeAttributionRow(r as MovementAttributionRow))
}

export async function getAttributionsForUser(userId: string): Promise<MovementAttributionRow[]> {
  await ensureMovementsSchema()
  const { rows } = await query<MovementAttributionRow & { gross_amount: string; net_amount: string }>(
    `SELECT id, user_id, movement_id, component_type, entity_id, reference_id,
            gross_amount, net_amount, confidence, source, metadata, confidence_detail, migrated_from_allocation_id, created_at
     FROM movement_attributions WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  )
  return rows.map((r) => normalizeAttributionRow(r as MovementAttributionRow))
}

export async function getAttributionsByEntity(
  componentType: "ar" | "ap",
  entityId: string,
): Promise<MovementAttributionRow[]> {
  await ensureMovementsSchema()
  const { rows } = await query<MovementAttributionRow & { gross_amount: string; net_amount: string }>(
    `SELECT id, user_id, movement_id, component_type, entity_id, reference_id,
            gross_amount, net_amount, confidence, source, metadata, confidence_detail, migrated_from_allocation_id, created_at
     FROM movement_attributions WHERE component_type = $1 AND entity_id = $2`,
    [componentType, entityId],
  )
  return rows.map((r) => normalizeAttributionRow(r as MovementAttributionRow))
}

export async function deleteAttribution(attributionId: string, userId: string): Promise<boolean> {
  await ensureMovementsSchema()
  const { rows } = await query<{ id: string }>(
    `DELETE FROM movement_attributions WHERE user_id = $1 AND id = $2 RETURNING id`,
    [userId, attributionId],
  )
  return rows.length > 0
}

export async function deleteAttributionByLegacyAllocationId(allocationId: string, userId: string): Promise<boolean> {
  await ensureMovementsSchema()
  const { rows } = await query<{ id: string }>(
    `DELETE FROM movement_attributions WHERE user_id = $1 AND migrated_from_allocation_id = $2 RETURNING id`,
    [userId, allocationId],
  )
  return rows.length > 0
}
