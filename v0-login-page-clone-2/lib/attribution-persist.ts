/**
 * Movement attributions: canonical decomposition of each movement (AR/AP/fee/transfer/settlement/unknown).
 */

import type { PoolClient } from "pg"
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
  /** Phase 2: category-based matching fields */
  category?: string | null
  cost_type?: string | null
  vendor_id?: string | null
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
  
  // Validate attribution values to prevent impossible data
  if (opts.component_type !== "fee") {
    // For AR/AP/settlement allocations, gross should be >= net (fee can't be negative)
    if (opts.gross_amount < opts.net_amount - 0.01) {
      console.warn(`[Attribution] Invalid: gross (${opts.gross_amount}) < net (${opts.net_amount}) for ${opts.component_type}`)
      // Swap to make valid - net becomes gross, gross becomes net
      const temp = opts.gross_amount
      opts.gross_amount = opts.net_amount
      opts.net_amount = temp
    }
    // Fee should be reasonable (< 20% of gross for AR/AP)
    const impliedFee = opts.gross_amount - opts.net_amount
    const feeRate = opts.gross_amount > 0 ? impliedFee / opts.gross_amount : 0
    if (feeRate > 0.20) {
      console.warn(`[Attribution] High fee rate (${(feeRate * 100).toFixed(1)}%) for ${opts.component_type}: gross=${opts.gross_amount}, net=${opts.net_amount}`)
    }
  }
  
  const metadata = { ...opts.metadata }
  const confDetail = opts.confidenceEnvelope
    ? serializeConfidenceEnvelope(opts.confidenceEnvelope)
    : opts.confidence
      ? serializeConfidenceEnvelope(confidenceFromScore(opts.confidence))
      : null

  // Use upsert pattern to handle both partial unique indexes
  // First try to find existing attribution
  const existingQuery = opts.reference_id
    ? `SELECT id FROM movement_attributions 
       WHERE movement_id = $1 AND component_type = $2 AND reference_id = $3 AND source = $4`
    : `SELECT id FROM movement_attributions 
       WHERE movement_id = $1 AND component_type = $2 AND entity_id = $3 AND source = $4 AND reference_id IS NULL`
  
  const existingParams = opts.reference_id
    ? [opts.movementId, opts.component_type, opts.reference_id, opts.source]
    : [opts.movementId, opts.component_type, opts.entity_id, opts.source]
  
  const existing = await query<{ id: string }>(existingQuery, existingParams)
  
  if (existing.rows.length > 0) {
    // Update existing attribution
    const { rows } = await query<
      MovementAttributionRow & { gross_amount: string; net_amount: string }
    >(
      `UPDATE movement_attributions SET
        gross_amount = $2,
        net_amount = $3,
        confidence = $4,
        metadata = $5::jsonb,
        confidence_detail = $6::jsonb
      WHERE id = $1
      RETURNING id, user_id, movement_id, component_type, entity_id, reference_id,
        gross_amount, net_amount, confidence, source, metadata, confidence_detail, migrated_from_allocation_id, created_at`,
      [
        existing.rows[0].id,
        opts.gross_amount,
        opts.net_amount,
        opts.confidence,
        JSON.stringify(metadata),
        confDetail ? JSON.stringify(confDetail) : null,
      ],
    )
    const row = rows[0]
    if (!row) throw new Error("Failed to update attribution")
    return normalizeAttributionRow(row as MovementAttributionRow)
  }

  // Insert new attribution
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

/** Same as createAttribution but uses an existing transaction client. */
export async function insertAttributionWithClient(
  client: PoolClient,
  opts: CreateAttributionOpts,
): Promise<MovementAttributionRow> {
  // Validate attribution values to prevent impossible data
  if (opts.component_type !== "fee") {
    // For AR/AP/settlement allocations, gross should be >= net (fee can't be negative)
    if (opts.gross_amount < opts.net_amount - 0.01) {
      console.warn(`[Attribution] Invalid: gross (${opts.gross_amount}) < net (${opts.net_amount}) for ${opts.component_type}`)
      // Swap to make valid - net becomes gross, gross becomes net
      const temp = opts.gross_amount
      opts.gross_amount = opts.net_amount
      opts.net_amount = temp
    }
    // Fee should be reasonable (< 20% of gross for AR/AP)
    const impliedFee = opts.gross_amount - opts.net_amount
    const feeRate = opts.gross_amount > 0 ? impliedFee / opts.gross_amount : 0
    if (feeRate > 0.20) {
      console.warn(`[Attribution] High fee rate (${(feeRate * 100).toFixed(1)}%) for ${opts.component_type}: gross=${opts.gross_amount}, net=${opts.net_amount}`)
    }
  }

  const metadata = { ...opts.metadata }
  const confDetail = opts.confidenceEnvelope
    ? serializeConfidenceEnvelope(opts.confidenceEnvelope)
    : opts.confidence
      ? serializeConfidenceEnvelope(confidenceFromScore(opts.confidence))
      : null

  // Use upsert pattern to handle both partial unique indexes
  // First try to find existing attribution
  const existingQuery = opts.reference_id
    ? `SELECT id FROM movement_attributions 
       WHERE movement_id = $1 AND component_type = $2 AND reference_id = $3 AND source = $4`
    : `SELECT id FROM movement_attributions 
       WHERE movement_id = $1 AND component_type = $2 AND entity_id = $3 AND source = $4 AND reference_id IS NULL`
  
  const existingParams = opts.reference_id
    ? [opts.movementId, opts.component_type, opts.reference_id, opts.source]
    : [opts.movementId, opts.component_type, opts.entity_id, opts.source]
  
  const existing = await client.query<{ id: string }>(existingQuery, existingParams)
  
  if (existing.rows.length > 0) {
    // Update existing attribution
    const result = await client.query<
      MovementAttributionRow & { gross_amount: string; net_amount: string }
    >(
      `UPDATE movement_attributions SET
        gross_amount = $2,
        net_amount = $3,
        confidence = $4,
        metadata = $5::jsonb,
        confidence_detail = $6::jsonb
      WHERE id = $1
      RETURNING id, user_id, movement_id, component_type, entity_id, reference_id,
        gross_amount, net_amount, confidence, source, metadata, confidence_detail, migrated_from_allocation_id, created_at`,
      [
        existing.rows[0].id,
        opts.gross_amount,
        opts.net_amount,
        opts.confidence,
        JSON.stringify(metadata),
        confDetail ? JSON.stringify(confDetail) : null,
      ],
    )
    const row = result.rows[0]
    if (!row) throw new Error("Failed to update attribution")
    return normalizeAttributionRow(row as MovementAttributionRow)
  }

  // #region agent log - hypothesis A: constraint violation on category/cost_type/vendor_id
  const logPayload = {
    sessionId: 'fee5c4',
    location: 'attribution-persist.ts:270',
    message: 'insertAttributionWithClient: about to insert',
    data: {
      movementId: opts.movementId,
      componentType: opts.component_type,
      category: opts.category ?? null,
      costType: opts.cost_type ?? null,
      vendorId: opts.vendor_id ?? null,
    },
    timestamp: Date.now(),
    runId: 'debug-run-1',
    hypothesisId: 'A',
  };
  try {
    await fetch('http://127.0.0.1:7742/ingest/b0bb6c9e-7e1d-4674-9db3-ac21c3d4fa72', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'fee5c4' },
      body: JSON.stringify(logPayload),
    }).catch(() => {});
  } catch {}
  // #endregion

  // #region agent log - hypothesis C: catch insert errors
  try {
    const result = await client.query<
      MovementAttributionRow & { gross_amount: string; net_amount: string }
    >(
      `INSERT INTO movement_attributions (
        user_id, movement_id, component_type, entity_id, reference_id,
        gross_amount, net_amount, confidence, source, metadata, confidence_detail, migrated_from_allocation_id,
        category, cost_type, vendor_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15)
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
        opts.category ?? null,
        opts.cost_type ?? null,
        opts.vendor_id ?? null,
      ],
    )
    const row = result.rows[0]
    if (!row) throw new Error("Failed to create attribution")
    return normalizeAttributionRow(row as MovementAttributionRow)
  } catch (err) {
    console.error("[insertAttributionWithClient] Insert failed:", err instanceof Error ? err.message : String(err));
    try {
      await fetch('http://127.0.0.1:7742/ingest/b0bb6c9e-7e1d-4674-9db3-ac21c3d4fa72', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'fee5c4' },
        body: JSON.stringify({
          sessionId: 'fee5c4',
          location: 'attribution-persist.ts:insertAttributionWithClient',
          message: 'insert_error',
          data: { 
            error: err instanceof Error ? err.message : String(err),
            code: (err as any)?.code,
            movementId: opts.movementId,
            componentType: opts.component_type,
          },
          timestamp: Date.now(),
          runId: 'debug-run-2',
          hypothesisId: 'C',
        }),
      }).catch(() => {});
    } catch {}
    throw err;
  }
  // #endregion
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
