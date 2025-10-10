// ─── State Engine: Orchestrator ──────────────────────────────────────
//
// Loads tagged movements and computes the full BusinessState.
// This is the single entry point for all state computation.

import { query, ensureMovementsSchema } from "@/lib/db"
import { toMovementClass, computeStatePolicy, computeStateScope } from "@/lib/movement-types"
import type { CanonicalMovement, MovementTag, ReviewReason } from "@/lib/movement-types"
import { computeRevenueState, computeSpendState, computeLiquidityState, detectTransitions, computeStateConfidence, computeInsightBlock } from "./compute"
import type { BusinessState } from "./types"

type TagRow = {
  movement_id: string
  economic_class: string
  cashflow_bucket: string
  counterparty_role: string
  tag_data: Record<string, unknown>
}

type TaggedMovement = CanonicalMovement & { tag: MovementTag }

export async function computeBusinessState(userId: string): Promise<BusinessState> {
  await ensureMovementsSchema()

  type PlaidAcct = { account_id: string; name: string; type: string; subtype: string }
  const acctByName = new Map<string, PlaidAcct>()
  try {
    const acctRows = await query<PlaidAcct>(
      `SELECT pa.account_id, pa.name, pa.type, pa.subtype
       FROM plaid_accounts pa
       JOIN plaid_items pi ON pa.item_id = pi.item_id
       WHERE pi.user_id = $1`,
      [userId]
    ).then((r) => r.rows)
    for (const a of acctRows) {
      if (a.name) acctByName.set(a.name, a)
      acctByName.set(a.account_id, a)
    }
  } catch { /* plaid_accounts may not exist yet */ }

  const movementRows = await query<CanonicalMovement & { movement_type: string }>(
    `SELECT m.id, m.user_id, m.date AS occurred_at, m.direction, m.amount::float,
            m.currency, m.raw_description, m.movement_type,
            m.counterparty_entity_id AS entity_id,
            COALESCE(NULLIF(TRIM(m.cash_account_id), ''), 
              (SELECT mo.account_name FROM movement_observations mo WHERE mo.movement_id = m.id AND mo.account_name IS NOT NULL AND TRIM(mo.account_name) != '' LIMIT 1)
            ) AS account_id,
            m.pnl_eligible, m.confidence, m.review_needed AS needs_review,
            m.provenance, m.coalesced_group_id, m.metadata
     FROM movements m WHERE m.user_id = $1
     ORDER BY m.date ASC`,
    [userId]
  ).then((r) => r.rows.map((row) => {
    const conf = (row.confidence as unknown as Record<string, number>) ?? {}
    const md = (row.metadata ?? {}) as Record<string, unknown>
    // cash_account_id in DB stores the account NAME (set during classification)
    const acctName = row.account_id ?? null
    const acctInfo = acctByName.get(acctName ?? "")
    return {
      ...row,
      amount: typeof row.amount === "string" ? parseFloat(row.amount) : row.amount,
      movement_class: toMovementClass(row.movement_type ?? "unknown"),
      movement_type_detail: row.movement_type ?? "unknown",
      source_record_ids: [],
      confidence: conf.score ?? 0,
      evidence_strength: conf.evidence_strength ?? 0,
      review_reasons: (Array.isArray(md.review_reasons) ? md.review_reasons : []) as ReviewReason[],
      metadata: {
        ...md,
        cash_account_name: acctName,
        account_type: acctInfo?.type ?? md.account_type ?? "",
        account_subtype: acctInfo?.subtype ?? md.account_subtype ?? null,
      },
    } as CanonicalMovement
  }))

  const tagRows = await query<TagRow>(
    `SELECT movement_id, economic_class, cashflow_bucket, counterparty_role, tag_data
     FROM movement_tags WHERE movement_id IN (SELECT id FROM movements WHERE user_id = $1)`,
    [userId]
  ).then((r) => r.rows)

  const tagMap = new Map<string, TagRow>()
  for (const t of tagRows) tagMap.set(t.movement_id, t)

  const tagged: TaggedMovement[] = []
  for (const m of movementRows) {
    const tr = tagMap.get(m.id)
    if (!tr) continue

    const td = tr.tag_data ?? {}
    const tag: MovementTag = {
      movement_id: m.id,
      economic_class: tr.economic_class as MovementTag["economic_class"],
      cashflow_bucket: tr.cashflow_bucket as MovementTag["cashflow_bucket"],
      counterparty_role: tr.counterparty_role as MovementTag["counterparty_role"],
      is_operating: (td.is_operating as boolean) ?? false,
      is_financing: (td.is_financing as boolean) ?? false,
      is_investing: (td.is_investing as boolean) ?? false,
      is_owner_related: (td.is_owner_related as boolean) ?? false,
      hits_pnl: (td.hits_pnl as boolean) ?? false,
      hits_working_capital: (td.hits_working_capital as boolean) ?? false,
      state_scope: (td.state_scope as MovementTag["state_scope"]) ?? computeStateScope(
        tr.economic_class as MovementTag["economic_class"],
        tr.cashflow_bucket as MovementTag["cashflow_bucket"],
        (td.hits_working_capital as boolean) ?? false,
      ),
      state_inclusion_policy: (td.state_inclusion_policy as MovementTag["state_inclusion_policy"]) ?? computeStatePolicy(m.confidence, m.evidence_strength, m.needs_review),
      classification_confidence: m.confidence,
      evidence_strength: m.evidence_strength,
      needs_review: m.needs_review,
      review_reasons: m.review_reasons,
      entity_id: m.entity_id,
      customer_id: (td.customer_id as string) ?? null,
      vendor_id: (td.vendor_id as string) ?? null,
      processor_id: (td.processor_id as string) ?? null,
      account_id: m.account_id,
      order_id: (td.order_id as string) ?? null,
      invoice_id: (td.invoice_id as string) ?? null,
      bill_id: (td.bill_id as string) ?? null,
      recurrence_family_id: (td.recurrence_family_id as string) ?? null,
      is_recurring: (td.is_recurring as boolean) ?? false,
      is_anomaly: (td.is_anomaly as boolean) ?? false,
      is_large_outlier: (td.is_large_outlier as boolean) ?? false,
      is_first_seen_counterparty: (td.is_first_seen_counterparty as boolean) ?? false,
    }

    tagged.push({ ...m, tag })
  }

  const dates = tagged.map((m) => m.occurred_at).filter(Boolean).sort()
  const periodStart = dates[0] ?? new Date().toISOString()
  const periodEnd = dates[dates.length - 1] ?? new Date().toISOString()

  const revenue = computeRevenueState(tagged, periodStart, periodEnd)
  const spend = computeSpendState(tagged, periodStart, periodEnd)
  const liquidity = computeLiquidityState(tagged, periodStart, periodEnd)
  const transitions = detectTransitions(revenue, spend, liquidity)
  const state_confidence = computeStateConfidence(tagged)
  const insight_block = computeInsightBlock(revenue, spend, liquidity)

  return {
    revenue,
    spend,
    liquidity,
    transitions,
    state_confidence,
    insight_block,
    computed_at: new Date().toISOString(),
  }
}
