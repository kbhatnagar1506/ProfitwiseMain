/**
 * Resolve display name for movements: entity canonical > merchant_tags normalized > counterparty.
 * Used for AI context and movement display.
 */

import { query, ensureMerchantTagsSchema } from "./db"

export type DisplayNameInput = {
  movement_id: string
  user_id: string
  counterparty: string | null
  counterparty_entity_id: string | null
}

export type DisplayNameResult = {
  movement_id: string
  /** Best display label: entity canonical > merchant normalized > counterparty */
  display_name: string | null
  /** Source of display_name for debugging */
  source: "entity" | "merchant_tag" | "counterparty" | "plaid_observation"
}

/**
 * Batch-resolve display names for movements.
 * Priority: entities.canonical_name > merchant_tags.normalized_name > counterparty
 */
export async function resolveDisplayNames(
  inputs: DisplayNameInput[]
): Promise<Map<string, DisplayNameResult>> {
  const result = new Map<string, DisplayNameResult>()
  if (inputs.length === 0) return result

  const movementIds = inputs.map((i) => i.movement_id)
  const userId = inputs[0].user_id

  // 1. Entity canonical names
  const entityIds = [...new Set(inputs.map((i) => i.counterparty_entity_id).filter(Boolean))] as string[]
  const entityNames = new Map<string, string>()
  if (entityIds.length > 0) {
    const rows = await query<{ id: string; canonical_name: string }>(
      `SELECT id, canonical_name FROM entities WHERE id = ANY($1)`,
      [entityIds]
    ).then((r) => r.rows)
    for (const r of rows) entityNames.set(r.id, r.canonical_name)
  }

  // 2. Merchant tags normalized names (for Plaid observations)
  let merchantByMovement = new Map<string, string>()
  try {
    await ensureMerchantTagsSchema()
    const { rows } = await query<{ movement_id: string; normalized_name: string }>(
      `SELECT DISTINCT ON (o.movement_id) o.movement_id, mt.normalized_name
       FROM movement_observations o
       JOIN merchant_tags mt ON mt.user_id = $2
         AND mt.account_id = o.account_id
         AND (mt.raw_name = COALESCE(TRIM(o.raw_description), '')
              OR mt.raw_name = COALESCE(TRIM(o.counterparty), ''))
       WHERE o.movement_id = ANY($1) AND o.source = 'plaid'`,
      [movementIds, userId]
    )
    for (const r of rows) {
      if (r.normalized_name?.trim()) merchantByMovement.set(r.movement_id, r.normalized_name.trim())
    }
  } catch {
    // merchant_tags may not exist or be empty
  }

  // 3. Build result: entity > merchant_tag > counterparty
  for (const inp of inputs) {
    const entityName = inp.counterparty_entity_id
      ? entityNames.get(inp.counterparty_entity_id) ?? null
      : null
    const merchantName = merchantByMovement.get(inp.movement_id) ?? null
    const counterparty = inp.counterparty?.trim() || null

    let display_name: string | null = null
    let source: DisplayNameResult["source"] = "counterparty"

    if (entityName?.trim()) {
      display_name = entityName.trim()
      source = "entity"
    } else if (merchantName) {
      display_name = merchantName
      source = "merchant_tag"
    } else if (counterparty) {
      display_name = counterparty
      source = "counterparty"
    }

    result.set(inp.movement_id, { movement_id: inp.movement_id, display_name, source })
  }

  return result
}

/**
 * Reconciliation / invoice matching: **bank data first** — merchant_tags normalized name, then
 * **Plaid movement_observations** (counterparty / raw_description from the bank line, not coalesced movement text),
 * then entity canonical, then movement counterparty. Movements can omit or reshape txs; observations keep bank truth.
 */
export async function resolveReconciliationBankLabelsForMatch(
  inputs: DisplayNameInput[],
): Promise<Map<string, DisplayNameResult>> {
  const result = new Map<string, DisplayNameResult>()
  if (inputs.length === 0) return result

  const movementIds = inputs.map((i) => i.movement_id)
  const userId = inputs[0].user_id

  const entityIds = [...new Set(inputs.map((i) => i.counterparty_entity_id).filter(Boolean))] as string[]
  const entityNames = new Map<string, string>()
  if (entityIds.length > 0) {
    const rows = await query<{ id: string; canonical_name: string }>(
      `SELECT id, canonical_name FROM entities WHERE id = ANY($1)`,
      [entityIds],
    ).then((r) => r.rows)
    for (const r of rows) entityNames.set(r.id, r.canonical_name)
  }

  /** Latest Plaid observation per movement — bank-reported strings before coalesce into movements.counterparty */
  const plaidObsLabelByMovement = new Map<string, string>()
  try {
    const { rows: obsRows } = await query<{ movement_id: string; raw_description: string | null; counterparty: string | null }>(
      `SELECT DISTINCT ON (o.movement_id) o.movement_id, o.raw_description, o.counterparty
       FROM movement_observations o
       JOIN movements m ON m.id = o.movement_id AND m.user_id = $2::uuid
       WHERE o.movement_id = ANY($1::uuid[]) AND o.source = 'plaid'
       ORDER BY o.movement_id, o.date DESC`,
      [movementIds, userId],
    )
    for (const r of obsRows) {
      const label = [r.counterparty, r.raw_description]
        .map((s) => (typeof s === "string" ? s.trim() : ""))
        .find((s) => s.length > 0)
      if (label) plaidObsLabelByMovement.set(r.movement_id, label)
    }
  } catch {
    /* observations missing */
  }

  let merchantByMovement = new Map<string, string>()
  try {
    await ensureMerchantTagsSchema()
    const { rows } = await query<{ movement_id: string; normalized_name: string }>(
      `SELECT DISTINCT ON (o.movement_id) o.movement_id, mt.normalized_name
       FROM movement_observations o
       JOIN merchant_tags mt ON mt.user_id = $2
         AND mt.account_id = o.account_id
         AND (mt.raw_name = COALESCE(TRIM(o.raw_description), '')
              OR mt.raw_name = COALESCE(TRIM(o.counterparty), ''))
       WHERE o.movement_id = ANY($1) AND o.source = 'plaid'`,
      [movementIds, userId],
    )
    for (const r of rows) {
      if (r.normalized_name?.trim()) merchantByMovement.set(r.movement_id, r.normalized_name.trim())
    }
  } catch {
    /* merchant_tags may not exist */
  }

  for (const inp of inputs) {
    const entityName = inp.counterparty_entity_id
      ? entityNames.get(inp.counterparty_entity_id) ?? null
      : null
    const merchantName = merchantByMovement.get(inp.movement_id) ?? null
    const plaidObsLabel = plaidObsLabelByMovement.get(inp.movement_id) ?? null
    const counterparty = inp.counterparty?.trim() || null

    let display_name: string | null = null
    let source: DisplayNameResult["source"] = "counterparty"

    if (merchantName) {
      display_name = merchantName
      source = "merchant_tag"
    } else if (plaidObsLabel) {
      display_name = plaidObsLabel
      source = "plaid_observation"
    } else if (entityName?.trim()) {
      display_name = entityName.trim()
      source = "entity"
    } else if (counterparty) {
      display_name = counterparty
      source = "counterparty"
    }

    result.set(inp.movement_id, { movement_id: inp.movement_id, display_name, source })
  }

  return result
}
