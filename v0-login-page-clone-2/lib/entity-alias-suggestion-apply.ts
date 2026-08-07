/**
 * Approve / reject entity_alias_suggestions — writes to entity_aliases (and optionally new entities).
 */

import { query, ensureMovementsSchema, ensureIdentitySchema } from "./db"
import { log } from "./logger"

const ALLOWED_ENTITY_TYPES = new Set([
  "vendor",
  "customer",
  "employee",
  "processor",
  "bank_account",
  "tax_authority",
  "owner",
  "lender",
  "internal",
  "unknown",
])

export type EntityAliasSuggestionRow = {
  id: string
  user_id: string
  movement_id: string | null
  raw_fingerprint: string
  suggested_entity_id: string | null
  suggested_alias: string
  alias_type: string
  confidence: number
  rationale: Record<string, unknown> | null
  status: string
  source: string
  canonical_name_hint: string | null
  create_new_entity: boolean
  suggested_entity_type: string | null
  created_at: string
}

function normalizeEntityType(t: string | null | undefined): string {
  const s = (t ?? "unknown").toLowerCase().trim()
  return ALLOWED_ENTITY_TYPES.has(s) ? s : "unknown"
}

export async function listPendingEntityAliasSuggestions(userId: string): Promise<EntityAliasSuggestionRow[]> {
  await ensureMovementsSchema()
  const { rows } = await query<EntityAliasSuggestionRow>(
    `SELECT id, user_id, movement_id, raw_fingerprint, suggested_entity_id, suggested_alias,
            alias_type, confidence, rationale, status, source, canonical_name_hint,
            create_new_entity, suggested_entity_type, created_at
     FROM entity_alias_suggestions
     WHERE user_id = $1 AND status = 'pending'
     ORDER BY created_at DESC
     LIMIT 200`,
    [userId],
  )
  return rows
}

export async function rejectEntityAliasSuggestion(userId: string, suggestionId: string): Promise<boolean> {
  await ensureMovementsSchema()
  const { rows } = await query<{ id: string }>(
    `UPDATE entity_alias_suggestions
     SET status = 'rejected', updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND status = 'pending'
     RETURNING id`,
    [suggestionId, userId],
  )
  return rows.length > 0
}

/**
 * Approve: insert entity (if create_new_entity), then entity_aliases. Marks suggestion approved.
 */
export async function approveEntityAliasSuggestion(userId: string, suggestionId: string): Promise<{
  ok: boolean
  error?: string
  entity_id?: string
}> {
  await ensureIdentitySchema()
  await ensureMovementsSchema()

  const { rows: srows } = await query<EntityAliasSuggestionRow>(
    `SELECT id, user_id, movement_id, raw_fingerprint, suggested_entity_id, suggested_alias,
            alias_type, confidence, rationale, status, source, canonical_name_hint,
            create_new_entity, suggested_entity_type, created_at
     FROM entity_alias_suggestions
     WHERE id = $1 AND user_id = $2 AND status = 'pending'`,
    [suggestionId, userId],
  )
  const s = srows[0]
  if (!s) return { ok: false, error: "Suggestion not found or not pending" }

  const aliasType = s.alias_type || "merchant_string"
  const alias = s.suggested_alias.trim()
  if (alias.length < 2) return { ok: false, error: "Invalid alias" }

  let entityId: string | null = s.suggested_entity_id

  try {
    if (s.create_new_entity) {
      const name = (s.canonical_name_hint ?? "").trim()
      if (!name) return { ok: false, error: "Missing canonical_name_hint for new entity" }
      const et = normalizeEntityType(s.suggested_entity_type)
      const { rows: ins } = await query<{ id: string }>(
        `INSERT INTO entities (user_id, entity_type, canonical_name, display_name, confidence)
         VALUES ($1, $2, $3, $3, $4)
         ON CONFLICT (user_id, canonical_name, entity_type) DO UPDATE SET
           confidence = GREATEST(entities.confidence, EXCLUDED.confidence),
           updated_at = NOW()
         RETURNING id`,
        [userId, et, name, Math.max(0.5, s.confidence)],
      )
      entityId = ins[0]?.id ?? null
      if (!entityId) return { ok: false, error: "Failed to create entity" }
    }

    if (!entityId) return { ok: false, error: "No entity to attach alias" }

    await query(
      `INSERT INTO entity_aliases (entity_id, alias, alias_type, source, source_id, confidence)
       VALUES ($1, $2, $3, 'user', $4, $5)
       ON CONFLICT (entity_id, alias, alias_type, source) DO UPDATE SET
         confidence = GREATEST(entity_aliases.confidence, EXCLUDED.confidence)`,
      [entityId, alias, aliasType, `alias_suggestion:${s.id}`, Math.max(0.55, s.confidence)],
    )

    await query(
      `UPDATE entity_alias_suggestions
       SET status = 'approved', updated_at = NOW(), suggested_entity_id = COALESCE(suggested_entity_id, $3)
       WHERE id = $1 AND user_id = $2`,
      [s.id, userId, entityId],
    )

    log("entity_alias_suggestion.approved", { userId, suggestionId: s.id, entityId }, "movements")
    return { ok: true, entity_id: entityId }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log("entity_alias_suggestion.approve_error", { userId, suggestionId, error: msg }, "movements")
    return { ok: false, error: msg }
  }
}
