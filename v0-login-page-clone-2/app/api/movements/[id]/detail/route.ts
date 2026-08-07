import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { ensureMovementsSchema, query } from "@/lib/db"
import { resolveDisplayNames } from "@/lib/display-name-resolve"
import { scrubMovementText } from "@/lib/text-cleaner"
import { validateUUID, createErrorResponse } from "@/lib/api-utils"
import { log } from "@/lib/logger"
import type { MovementDetailResponse } from "@/lib/movement-detail-types"

type DbMovementDetailRow = {
  id: string
  direction: "inflow" | "outflow"
  amount: string
  date: string
  movement_type: string
  pnl_eligible: boolean
  provenance: string
  cash_account_id: string | null
  counterparty: string | null
  counterparty_entity_id: string | null
  counterparty_entity_type: string | null
  confidence: Record<string, number>
  review_needed: boolean
  raw_description: string | null
  metadata: Record<string, unknown>
  currency: string | null
  coalesced_group_id: string | null
  observations: Array<{
    source: string
    source_type: string
    source_id: string
    amount: number | string | null
    date: string | null
    raw_description: string | null
    counterparty: string | null
    account_name: string | null
    account_id: string | null
    metadata?: Record<string, unknown>
  }> | null
}

function numOrNull(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

function bool(v: unknown): boolean {
  return v === true
}

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json(createErrorResponse("Unauthorized"), { status: 401 })

  const { id } = await context.params
  if (!id) return NextResponse.json(createErrorResponse("movement id required"), { status: 400 })

  // Validate UUID format
  if (!validateUUID(id)) {
    log("movements.detail.invalid_uuid", { userId: user.id, movementId: id })
    return NextResponse.json(createErrorResponse("Invalid movement ID format"), { status: 400 })
  }

  await ensureMovementsSchema()

  const { rows } = await query<DbMovementDetailRow>(
    `SELECT m.id, m.direction, m.amount, m.date, m.movement_type, m.pnl_eligible,
            m.provenance, m.cash_account_id, m.counterparty, m.counterparty_entity_id,
            m.counterparty_entity_type, m.confidence, m.review_needed, m.raw_description,
            m.metadata, m.currency, m.coalesced_group_id,
            COALESCE(
              json_agg(json_build_object(
                'source', o.source,
                'source_type', o.source_type,
                'source_id', o.source_id,
                'amount', o.amount,
                'date', o.date,
                'raw_description', o.raw_description,
                'counterparty', o.counterparty,
                'account_name', o.account_name,
                'account_id', o.account_id,
                'metadata', o.metadata
              ) ORDER BY o.created_at ASC) FILTER (WHERE o.id IS NOT NULL),
              '[]'
            ) AS observations
     FROM movements m
     LEFT JOIN movement_observations o ON o.movement_id = m.id
     WHERE m.user_id = $1 AND m.id = $2
     GROUP BY m.id`,
    [user.id, id]
  )
  const row = rows[0]
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const { rows: tagRows } = await query<{
    economic_class: string
    cashflow_bucket: string
    counterparty_role: string
    tag_data: Record<string, unknown>
  }>(
    `SELECT economic_class, cashflow_bucket, counterparty_role, tag_data
     FROM movement_tags WHERE movement_id = $1`,
    [row.id]
  )
  const tag = tagRows[0]
  const tagData = (tag?.tag_data ?? {}) as Record<string, unknown>

  const { rows: entityRows } = row.counterparty_entity_id
    ? await query<{ canonical_name: string }>(
      `SELECT canonical_name FROM entities WHERE id = $1`,
      [row.counterparty_entity_id]
    )
    : { rows: [] as Array<{ canonical_name: string }> }
  const entityCanonicalName = entityRows[0]?.canonical_name ?? null

  const displayMap = await resolveDisplayNames([{
    movement_id: row.id,
    user_id: user.id,
    counterparty: row.counterparty,
    counterparty_entity_id: row.counterparty_entity_id,
  }])
  const displayName = displayMap.get(row.id)?.display_name
    ?? entityCanonicalName
    ?? row.counterparty
    ?? null

  const observations = (row.observations ?? []).map((o) => ({
    source: o.source,
    source_type: o.source_type,
    source_id: o.source_id,
    amount: numOrNull(o.amount),
    date: o.date,
    raw_description: o.raw_description,
    counterparty: o.counterparty,
    account_name: o.account_name,
    account_id: o.account_id,
    metadata: (o.metadata ?? {}) as Record<string, unknown>,
  }))

  const primaryObs = observations.find((o) => o.source === "plaid") ?? observations[0] ?? null
  const rawBankText = primaryObs?.raw_description ?? row.raw_description
  const scrubbedBankText = scrubMovementText(rawBankText, row.counterparty)

  const policyStatus = (tagData.policy_status as string | undefined)
    ?? (row.review_needed ? "excluded_for_review" : (row.movement_type?.startsWith("unknown") ?? false) ? "unresolved" : "included")
  const hitsPnl = bool(tagData.hits_pnl) || row.pnl_eligible
  const statusBadge: MovementDetailResponse["headline"]["status_badge"] =
    policyStatus === "unresolved"
      ? "unresolved"
      : (policyStatus === "excluded_for_review" || row.review_needed)
        ? "excluded_needs_review"
        : hitsPnl
          ? "included_pnl"
          : "included_non_pnl"

  const confidence = (row.confidence ?? {}) as Record<string, number>
  const reviewReasons = Array.isArray(row.metadata?.review_reasons)
    ? (row.metadata.review_reasons as string[])
    : []
  const explanationLines: string[] = []
  if ((row.metadata?.classification_precedence as string | undefined)) {
    explanationLines.push(`Precedence rule: ${String(row.metadata.classification_precedence)}`)
  }
  if ((row.metadata?.alias_signature as string | undefined)) {
    explanationLines.push(`Alias signature matched: ${String(row.metadata.alias_signature)}`)
  }
  if (reviewReasons.length > 0) {
    explanationLines.push(`Review flags: ${reviewReasons.join(", ")}`)
  }

  const response: MovementDetailResponse = {
    headline: {
      movement_id: row.id,
      amount: Number(row.amount),
      currency: row.currency ?? "USD",
      direction: row.direction,
      date: row.date,
      canonical_entity_name: entityCanonicalName,
      raw_counterparty: row.counterparty,
      status_badge: statusBadge,
    },
    economic_semantics: {
      movement_type: row.movement_type,
      economic_class: tag?.economic_class ?? null,
      cashflow_bucket: tag?.cashflow_bucket ?? null,
      counterparty_role: tag?.counterparty_role ?? row.counterparty_entity_type ?? null,
      flags: {
        hits_pnl: hitsPnl,
        hits_working_capital: bool(tagData.hits_working_capital),
        is_recurring: bool(tagData.is_recurring),
        is_owner_related: bool(tagData.is_owner_related),
        needs_review: row.review_needed,
      },
      policy_status: policyStatus,
    },
    evidence_trail: {
      observations,
      coalesced_group_id: row.coalesced_group_id,
      provenance: row.provenance,
    },
    confidence_engine: {
      overall: {
        classification_score: numOrNull(confidence.score) ?? 0,
        evidence_strength: numOrNull(confidence.evidence_strength) ?? 0,
      },
      breakdown: {
        entity_confidence: numOrNull(confidence.entity_confidence),
        amount_match: numOrNull(confidence.amount_match),
        date_match: numOrNull(confidence.date_match),
        source_agreement: numOrNull(confidence.source_agreement),
        source_authority: numOrNull(confidence.source_authority),
        pattern_strength: numOrNull(confidence.pattern_strength),
        history: numOrNull(confidence.history),
        directional_consistency: numOrNull(confidence.directional_consistency),
        account_resolution: numOrNull(confidence.account_resolution),
      },
      reasons: reviewReasons,
      explanation_lines: explanationLines,
    },
    normalized_bank_info: {
      raw_bank_text: rawBankText,
      scrubbed_bank_text: scrubbedBankText,
      normalized_display_name: displayName,
      resolution_path: {
        classification_precedence: (row.metadata?.classification_precedence as string | undefined) ?? null,
        canonical_alias_id: (row.metadata?.canonical_alias_id as string | undefined) ?? null,
        alias_signature: (row.metadata?.alias_signature as string | undefined) ?? null,
        counterparty_entity_id: row.counterparty_entity_id,
        counterparty_entity_type: row.counterparty_entity_type,
      },
    },
    controls: {
      can_recategorize: true,
      can_unmerge_entity: true,
      can_split_movement: false,
      can_force_policy: true,
      current_overrides: {
        forced_include: tagData.user_override_policy_status === "included",
        forced_exclude: tagData.user_override_policy_status === "excluded_for_review",
        manual_movement_type: (row.metadata?.manual_movement_type as string | undefined) ?? null,
      },
    },
  }

  return NextResponse.json(response)
}
