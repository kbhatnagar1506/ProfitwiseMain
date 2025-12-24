import { NextResponse, NextRequest } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query, ensureMovementsSchema } from "@/lib/db"
import { toMovementClass } from "@/lib/movement-types"
import { isValidQueryResult } from "@/lib/api-utils"
import { log, logWithRequestId } from "@/lib/logger"
import { getOrCreateRequestId, addRequestIdToResponse } from "@/lib/request-id-middleware"
import type { CanonicalMovement, MovementClass, ReviewReason } from "@/lib/movement-types"
import { resolveDisplayNames } from "@/lib/display-name-resolve"

type DbMovementRow = {
  id: string
  user_id: string
  direction: string
  amount: string
  date: string
  movement_type: string
  pnl_eligible: boolean
  provenance: string
  cash_account_id: string | null
  counterparty: string | null
  counterparty_entity_id: string | null
  counterparty_entity_type: string | null
  linked_internal_account_id: string | null
  confidence: Record<string, number>
  review_needed: boolean
  raw_description: string | null
  metadata: Record<string, unknown>
  currency: string | null
  coalesced_group_id: string | null
  created_at: string
  observations: Array<{ source_id: string; source: string; source_type: string; [k: string]: unknown }> | null
}

// Type guard for DbMovementRow
function isValidMovementRow(row: any): row is DbMovementRow {
  return (
    typeof row?.id === 'string' &&
    typeof row?.direction === 'string' &&
    typeof row?.amount === 'string' &&
    typeof row?.date === 'string' &&
    typeof row?.movement_type === 'string'
  )
}

function toPublicMovement(row: DbMovementRow, userId: string): CanonicalMovement {
  const obs = row.observations ?? []
  const reviewReasons = (Array.isArray(row.metadata?.review_reasons) ? row.metadata.review_reasons : []) as ReviewReason[]
  const meta = { ...(row.metadata ?? {}), counterparty: row.counterparty, linked_internal_account_id: row.linked_internal_account_id }

  return {
    id: row.id,
    user_id: userId,
    occurred_at: row.date,
    direction: row.direction as "inflow" | "outflow",
    amount: (() => { const amt = parseFloat(row.amount); return isNaN(amt) ? 0 : amt })(),
    currency: row.currency ?? "USD",
    raw_description: row.raw_description,
    source_record_ids: obs.map((o) => o.source_id).filter(Boolean),
    entity_id: row.counterparty_entity_id,
    account_id: row.cash_account_id,
    movement_class: toMovementClass(row.movement_type),
    movement_type_detail: row.movement_type,
    pnl_eligible: row.pnl_eligible,
    confidence: (() => { const conf = row.confidence?.score ?? 0; return isNaN(conf) ? 0 : conf })(),
    evidence_strength: (() => { const ev = row.confidence?.evidence_strength ?? 0; return isNaN(ev) ? 0 : ev })(),
    needs_review: row.review_needed,
    review_reasons: reviewReasons,
    provenance: row.provenance as CanonicalMovement["provenance"],
    coalesced_group_id: row.coalesced_group_id,
    metadata: meta,
  }
}

export async function GET(req?: NextRequest) {
  const requestId = getOrCreateRequestId(req)
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    await ensureMovementsSchema()
  } catch {
    return NextResponse.json({ movements: [], summary: {} })
  }

  const userId = user.id

  const dbRows = await query<DbMovementRow>(
    `SELECT m.id, m.direction, m.amount, m.date, m.movement_type, m.pnl_eligible,
            m.provenance, m.cash_account_id, m.counterparty, m.counterparty_entity_id,
            m.counterparty_entity_type, m.linked_internal_account_id,
            m.confidence, m.review_needed, m.raw_description, m.metadata,
            m.currency, m.coalesced_group_id, m.created_at,
            COALESCE(
              json_agg(json_build_object(
                'id', o.id, 'source', o.source, 'source_type', o.source_type,
                'source_id', o.source_id, 'amount', o.amount, 'date', o.date,
                'raw_description', o.raw_description, 'counterparty', o.counterparty,
                'account_name', o.account_name, 'account_id', o.account_id
              )) FILTER (WHERE o.id IS NOT NULL),
              '[]'
            ) AS observations
     FROM movements m
     LEFT JOIN movement_observations o ON o.movement_id = m.id
     WHERE m.user_id = $1 AND m.duplicate_of IS NULL
     GROUP BY m.id
     ORDER BY m.date DESC, m.created_at DESC`,
    [userId]
  ).then((r) => r.rows)

  const movements: CanonicalMovement[] = dbRows
    .filter(isValidMovementRow)
    .map((r) => toPublicMovement(r, userId))

  // Load tags (if they exist) and attach to movements
  type TagRow = { movement_id: string; economic_class: string; cashflow_bucket: string; counterparty_role: string; tag_data: Record<string, unknown> }
  const tagRows = await query<TagRow>(
    `SELECT movement_id, economic_class, cashflow_bucket, counterparty_role, tag_data
     FROM movement_tags WHERE movement_id IN (SELECT id FROM movements WHERE user_id = $1)`,
    [userId]
  ).then((r) => r.rows)

  const tagMap = new Map<string, TagRow>()
  for (const t of tagRows) tagMap.set(t.movement_id, t)

  // Resolve display names: entity canonical > merchant_tags normalized > counterparty
  const displayInputs = movements.map((m) => ({
    movement_id: m.id,
    user_id: userId,
    counterparty: (m.metadata?.counterparty as string) ?? null,
    counterparty_entity_id: m.entity_id,
  }))
  const displayNames = await resolveDisplayNames(displayInputs)

  // Fetch entity canonical names for resolved counterparties (Phase 7 display)
  const entityIds = [...new Set(movements.map((m) => m.entity_id).filter(Boolean))] as string[]
  const entityNames = new Map<string, string>()
  if (entityIds.length > 0) {
    const entityRows = await query<{ id: string; canonical_name: string }>(
      `SELECT id, canonical_name FROM entities WHERE id = ANY($1)`,
      [entityIds]
    ).then((r) => r.rows)
    for (const e of entityRows) entityNames.set(e.id, e.canonical_name)
  }

  const movementsWithTags = movements.map((m) => {
    const tag = tagMap.get(m.id)
    const entityCanonicalName = m.entity_id ? entityNames.get(m.entity_id) ?? null : null
    const displayRes = displayNames.get(m.id)
    const display_name = displayRes?.display_name ?? entityCanonicalName ?? undefined
    if (!tag) return { ...m, tag: display_name ? { entity_canonical_name: entityCanonicalName ?? undefined, display_name } : undefined }
    return {
      ...m,
      tag: {
        economic_class: tag.economic_class,
        cashflow_bucket: tag.cashflow_bucket,
        counterparty_role: tag.counterparty_role,
        entity_canonical_name: entityCanonicalName ?? undefined,
        display_name,
        ...tag.tag_data,
      },
    }
  })

  type SummaryDbRow = { movement_type: string; pnl_eligible: boolean; count: number; total_amount: string }
  const summaryRows = await query<SummaryDbRow>(
    `SELECT movement_type, pnl_eligible, COUNT(*)::int as count, SUM(amount)::text as total_amount
     FROM movements WHERE user_id = $1 AND duplicate_of IS NULL
     GROUP BY movement_type, pnl_eligible
     ORDER BY count DESC`,
    [userId]
  ).then((r) => r.rows)

  const summary = summaryRows.map((row) => ({
    movement_class: toMovementClass(row.movement_type),
    movement_type_detail: row.movement_type,
    count: row.count,
    total_amount: row.total_amount,
    pnl_eligible: row.pnl_eligible,
  }))

  // When tags exist, compute authoritative summary from tagged movements (plan #1, #6)
  type TaggedMovement = (typeof movementsWithTags)[number] & { tag?: { hits_pnl?: boolean; economic_class?: string; state_inclusion_policy?: string; policy_status?: string; needs_review?: boolean } }
  let summaryFromTags: {
    pnl_count: number
    non_pnl_count: number
    excluded_for_review: number
    unresolved: number
    coalesced_count: number
    included_pnl: number
    included_non_pnl: number
    included_count: number
    class_counts: Record<string, { count: number; total_amount: number }>
  } | null = null

  if (tagRows.length > 0) {
    const classCounts: Record<string, { count: number; total_amount: number }> = {}
    let pnlCount = 0
    let nonPnlCount = 0
    let excludedForReview = 0
    let unresolved = 0
    let coalescedCount = 0
    let includedPnl = 0
    let includedNonPnl = 0

    // Coalesced hidden: movements with duplicate_of (not in tag flow)
    const { rows: coalescedRows } = await query<{ count: string }>(
      `SELECT COUNT(*)::text FROM movements WHERE user_id = $1 AND duplicate_of IS NOT NULL`,
      [userId]
    )
    coalescedCount = parseInt(coalescedRows[0]?.count ?? "0", 10)

    for (const m of movementsWithTags as TaggedMovement[]) {
      const tag = m.tag
      if (!tag) continue

      const ec = tag.economic_class ?? "unknown"
      const hitsPnl = tag.hits_pnl ?? false
      const policyStatus = (tag.policy_status as "included" | "excluded_for_review" | "unresolved" | "coalesced_hidden") ??
        (tag.state_inclusion_policy === "exclude_and_review" || tag.needs_review ? "excluded_for_review" : ec === "unknown" ? "unresolved" : "included")

      const mc = m.movement_class
      if (!classCounts[mc]) classCounts[mc] = { count: 0, total_amount: 0 }
      classCounts[mc].count++
      classCounts[mc].total_amount += m.amount

      if (hitsPnl) pnlCount++
      else if (ec !== "unknown") nonPnlCount++

      if (policyStatus === "unresolved") unresolved++
      else if (policyStatus === "excluded_for_review") excludedForReview++
      else if (policyStatus === "included") {
        if (hitsPnl) includedPnl++
        else includedNonPnl++
      }
    }

    summaryFromTags = {
      pnl_count: pnlCount,
      non_pnl_count: nonPnlCount,
      excluded_for_review: excludedForReview,
      unresolved,
      coalesced_count: coalescedCount,
      included_pnl: includedPnl,
      included_non_pnl: includedNonPnl,
      included_count: includedPnl + includedNonPnl,
      class_counts: classCounts,
    }
  }

  logWithRequestId("movements.list.success", requestId, { userId, movementCount: movementsWithTags.length, operation: "list_movements" })
  const response = NextResponse.json({ movements: movementsWithTags, summary, summary_from_tags: summaryFromTags })
  return addRequestIdToResponse(response, requestId)
}
