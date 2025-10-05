import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query, ensureMovementsSchema } from "@/lib/db"
import { toMovementClass } from "@/lib/movement-types"
import type { CanonicalMovement, MovementClass, ReviewReason } from "@/lib/movement-types"

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

function toPublicMovement(row: DbMovementRow, userId: string): CanonicalMovement {
  const obs = row.observations ?? []
  const reviewReasons = (Array.isArray(row.metadata?.review_reasons) ? row.metadata.review_reasons : []) as ReviewReason[]
  const meta = { ...(row.metadata ?? {}), counterparty: row.counterparty, linked_internal_account_id: row.linked_internal_account_id }

  return {
    id: row.id,
    user_id: userId,
    occurred_at: row.date,
    direction: row.direction as "inflow" | "outflow",
    amount: parseFloat(row.amount),
    currency: row.currency ?? "USD",
    raw_description: row.raw_description,
    source_record_ids: obs.map((o) => o.source_id).filter(Boolean),
    entity_id: row.counterparty_entity_id,
    account_id: row.cash_account_id,
    movement_class: toMovementClass(row.movement_type),
    movement_type_detail: row.movement_type,
    pnl_eligible: row.pnl_eligible,
    confidence: row.confidence?.score ?? 0,
    evidence_strength: row.confidence?.evidence_strength ?? 0,
    needs_review: row.review_needed,
    review_reasons: reviewReasons,
    provenance: row.provenance as CanonicalMovement["provenance"],
    coalesced_group_id: row.coalesced_group_id,
    metadata: meta,
  }
}

export async function GET() {
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
     WHERE m.user_id = $1
     GROUP BY m.id
     ORDER BY m.date DESC, m.created_at DESC`,
    [userId]
  ).then((r) => r.rows)

  const movements: CanonicalMovement[] = dbRows.map((r) => toPublicMovement(r, userId))

  // Load tags (if they exist) and attach to movements
  type TagRow = { movement_id: string; economic_class: string; cashflow_bucket: string; counterparty_role: string; tag_data: Record<string, unknown> }
  const tagRows = await query<TagRow>(
    `SELECT movement_id, economic_class, cashflow_bucket, counterparty_role, tag_data
     FROM movement_tags WHERE movement_id IN (SELECT id FROM movements WHERE user_id = $1)`,
    [userId]
  ).then((r) => r.rows)

  const tagMap = new Map<string, TagRow>()
  for (const t of tagRows) tagMap.set(t.movement_id, t)

  const movementsWithTags = movements.map((m) => {
    const tag = tagMap.get(m.id)
    if (!tag) return m
    return {
      ...m,
      tag: {
        economic_class: tag.economic_class,
        cashflow_bucket: tag.cashflow_bucket,
        counterparty_role: tag.counterparty_role,
        ...tag.tag_data,
      },
    }
  })

  type SummaryDbRow = { movement_type: string; pnl_eligible: boolean; count: number; total_amount: string }
  const summaryRows = await query<SummaryDbRow>(
    `SELECT movement_type, pnl_eligible, COUNT(*)::int as count, SUM(amount)::text as total_amount
     FROM movements WHERE user_id = $1
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

  return NextResponse.json({ movements: movementsWithTags, summary })
}
