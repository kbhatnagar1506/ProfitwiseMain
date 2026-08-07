import { NextResponse, NextRequest } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { ensureMovementsSchema, query } from "@/lib/db"
import type { MovementDetailResponse } from "@/lib/movement-detail-types"
import { generateMovementExplanation } from "@/lib/movement-explain"
import { rateLimiters, getRateLimitHeaders } from "@/lib/rate-limiter"
import { log } from "@/lib/logger"
import { checkRequestSize, getSizeLimitHeaders } from "@/lib/request-size-limiter"

type CacheRow = {
  movement_id: string
  status: "processing" | "ready" | "error"
  explanation: string | null
  updated_at: string
}

function parseMovementIds(value: string | null): string[] {
  if (!value) return []
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
}

export async function GET(req: Request) {
  // Check request size
  const contentLength = req.headers.get("content-length")
  const contentType = req.headers.get("content-type")
  const sizeCheck = checkRequestSize(contentLength ? parseInt(contentLength) : null, contentType)
  
  if (!sizeCheck.allowed) {
    log("movements.explain.batch.size_exceeded", { error: sizeCheck.error })
    return NextResponse.json(
      { error: sizeCheck.error },
      {
        status: 413,
        headers: getSizeLimitHeaders(),
      }
    )
  }

  const clientIp = (req as any).headers?.get('x-forwarded-for') || (req as any).headers?.get('x-real-ip') || 'unknown'
  const rateLimitCheck = rateLimiters.expensive.check({ ip: clientIp })
  
  if (!rateLimitCheck.allowed) {
    const status = rateLimiters.expensive.getStatus({ ip: clientIp })
    log("movements.explain.batch.rate_limited", { ip: clientIp, operation: "batch_explain" })
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      {
        status: 429,
        headers: getRateLimitHeaders(status),
      }
    )
  }

  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const url = new URL(req.url)
  const ids = parseMovementIds(url.searchParams.get("movement_ids"))
  if (ids.length === 0) return NextResponse.json({ explanations: {}, status: {} })

  await ensureMovementsSchema()
  const { rows } = await query<CacheRow>(
    `SELECT movement_id, status, explanation, updated_at::text
     FROM movement_explanations_cache
     WHERE user_id = $1 AND movement_id = ANY($2::uuid[])`,
    [user.id, ids],
  )

  const explanations: Record<string, string> = {}
  const status: Record<string, string> = {}
  for (const row of rows) {
    status[row.movement_id] = row.status
    if (row.status === "ready" && row.explanation) explanations[row.movement_id] = row.explanation
  }
  return NextResponse.json({ explanations, status, count_ready: Object.keys(explanations).length })
}

type BatchMovementRow = {
  id: string
  direction: "inflow" | "outflow"
  amount: string
  date: string
  movement_type: string
  counterparty: string | null
  counterparty_entity_id: string | null
  counterparty_entity_type: string | null
  confidence: Record<string, number> | null
  review_needed: boolean
  raw_description: string | null
  metadata: Record<string, unknown> | null
  provenance: string
  currency: string | null
  obs_refs: Array<{ source: string; source_type: string; source_id: string }> | null
  economic_class: string | null
  cashflow_bucket: string | null
  counterparty_role: string | null
  tag_data: Record<string, unknown> | null
}

function toDetail(row: BatchMovementRow): MovementDetailResponse {
  const confidence = (row.confidence ?? {}) as Record<string, number>
  const tagData = (row.tag_data ?? {}) as Record<string, unknown>
  const hitsPnl = tagData.hits_pnl === true
  const policyStatus = (tagData.policy_status as string | undefined)
    ?? (row.review_needed ? "excluded_for_review" : row.movement_type.startsWith("unknown") ? "unresolved" : "included")
  const statusBadge: MovementDetailResponse["headline"]["status_badge"] =
    policyStatus === "unresolved"
      ? "unresolved"
      : (policyStatus === "excluded_for_review" || row.review_needed)
        ? "excluded_needs_review"
        : hitsPnl
          ? "included_pnl"
          : "included_non_pnl"

  return {
    headline: {
      movement_id: row.id,
      amount: Number(row.amount),
      currency: row.currency ?? "USD",
      direction: row.direction,
      date: row.date,
      canonical_entity_name: null,
      raw_counterparty: row.counterparty,
      status_badge: statusBadge,
    },
    economic_semantics: {
      movement_type: row.movement_type,
      economic_class: row.economic_class,
      cashflow_bucket: row.cashflow_bucket,
      counterparty_role: row.counterparty_role ?? row.counterparty_entity_type,
      flags: {
        hits_pnl: hitsPnl,
        hits_working_capital: tagData.hits_working_capital === true,
        is_recurring: tagData.is_recurring === true,
        is_owner_related: tagData.is_owner_related === true,
        needs_review: row.review_needed,
      },
      policy_status: policyStatus,
    },
    evidence_trail: {
      observations: (row.obs_refs ?? []).map((o) => ({
        source: o.source,
        source_type: o.source_type,
        source_id: o.source_id,
        amount: null,
        date: null,
        raw_description: null,
        counterparty: null,
        account_name: null,
        account_id: null,
        metadata: {},
      })),
      coalesced_group_id: null,
      provenance: row.provenance,
    },
    confidence_engine: {
      overall: {
        classification_score: typeof confidence.score === "number" ? confidence.score : 0,
        evidence_strength: typeof confidence.evidence_strength === "number" ? confidence.evidence_strength : 0,
      },
      breakdown: {
        entity_confidence: typeof confidence.entity_confidence === "number" ? confidence.entity_confidence : null,
        amount_match: typeof confidence.amount_match === "number" ? confidence.amount_match : null,
        date_match: typeof confidence.date_match === "number" ? confidence.date_match : null,
        source_agreement: typeof confidence.source_agreement === "number" ? confidence.source_agreement : null,
        source_authority: typeof confidence.source_authority === "number" ? confidence.source_authority : null,
        pattern_strength: typeof confidence.pattern_strength === "number" ? confidence.pattern_strength : null,
        history: typeof confidence.history === "number" ? confidence.history : null,
        directional_consistency: typeof confidence.directional_consistency === "number" ? confidence.directional_consistency : null,
        account_resolution: typeof confidence.account_resolution === "number" ? confidence.account_resolution : null,
      },
      reasons: [],
      explanation_lines: [],
    },
    normalized_bank_info: {
      raw_bank_text: row.raw_description,
      scrubbed_bank_text: String(row.raw_description ?? "").toUpperCase(),
      normalized_display_name: row.counterparty,
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
}

export async function POST(req: Request) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json().catch((err) => {
    log("movements.explain.batch.json_parse_error", { error: err instanceof Error ? err.message : String(err) })
    return {}
  })
  const movementIds = Array.isArray(body?.movement_ids) 
    ? (body.movement_ids as string[]).filter(Boolean).slice(0, 100)  // Max 100 items
    : []
  const batchSize = Number.isFinite(body?.batch_size) ? Math.max(1, Math.min(20, Number(body.batch_size))) : 5
  if (movementIds.length === 0) return NextResponse.json({ generated: 0 })

  await ensureMovementsSchema()

  const { rows: existingRows } = await query<CacheRow>(
    `SELECT movement_id, status, explanation, updated_at::text
     FROM movement_explanations_cache
     WHERE user_id = $1 AND movement_id = ANY($2::uuid[])`,
    [user.id, movementIds],
  )
  const ready = new Set(existingRows.filter((r) => r.status === "ready" && r.explanation).map((r) => r.movement_id))
  const targets = movementIds.filter((id) => !ready.has(id)).slice(0, batchSize)
  if (targets.length === 0) return NextResponse.json({ generated: 0, done: true })

  const { rows } = await query<BatchMovementRow>(
    `SELECT
      m.id, m.direction, m.amount, m.date, m.movement_type, m.counterparty,
      m.counterparty_entity_id, m.counterparty_entity_type, m.confidence, m.review_needed,
      m.raw_description, m.metadata, m.provenance, m.currency,
      mt.economic_class, mt.cashflow_bucket, mt.counterparty_role, mt.tag_data,
      COALESCE(
        json_agg(json_build_object('source', o.source, 'source_type', o.source_type, 'source_id', o.source_id)
          ORDER BY o.created_at DESC) FILTER (WHERE o.id IS NOT NULL),
        '[]'
      ) AS obs_refs
     FROM movements m
     LEFT JOIN movement_tags mt ON mt.movement_id = m.id
     LEFT JOIN movement_observations o ON o.movement_id = m.id
     WHERE m.user_id = $1 AND m.id = ANY($2::uuid[])
     GROUP BY m.id, mt.economic_class, mt.cashflow_bucket, mt.counterparty_role, mt.tag_data`,
    [user.id, targets],
  )

  let generated = 0
  for (const row of rows) {
    try {
      await query(
        `INSERT INTO movement_explanations_cache (user_id, movement_id, status, explanation, error_message, updated_at)
         VALUES ($1, $2, 'processing', NULL, NULL, NOW())
         ON CONFLICT (user_id, movement_id)
         DO UPDATE SET status = 'processing', error_message = NULL, updated_at = NOW()`,
        [user.id, row.id],
      )
      const explanation = await generateMovementExplanation(user.id, toDetail(row))
      await query(
        `UPDATE movement_explanations_cache
         SET status = 'ready', explanation = $3, error_message = NULL, updated_at = NOW()
         WHERE user_id = $1 AND movement_id = $2`,
        [user.id, row.id, explanation],
      )
      generated++
    } catch (e) {
      await query(
        `UPDATE movement_explanations_cache
         SET status = 'error', error_message = $3, updated_at = NOW()
         WHERE user_id = $1 AND movement_id = $2`,
        [user.id, row.id, String(e)],
      )
    }
  }

  return NextResponse.json({ generated, attempted: rows.length, remaining_estimate: Math.max(0, movementIds.length - ready.size - generated) })
}
