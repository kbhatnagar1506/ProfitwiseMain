import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query, ensureMovementsSchema } from "@/lib/db"

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

  const movementsRaw = await query(
    `SELECT m.id, m.event_id, m.source, m.source_type, m.source_id, m.entity_id, m.date, m.amount,
            m.raw_description, m.counterparty, m.movement_class, m.pnl_eligible,
            m.statement_impact, m.movement_subclass, m.event_type, m.movement_mechanic, m.review_status,
            m.from_account, m.to_account, m.confidence, m.metadata, m.created_at,
            e.canonical_name as entity_canonical_name
     FROM movements m
     LEFT JOIN entities e ON m.entity_id = e.id
     WHERE m.user_id = $1
     ORDER BY m.date DESC, m.created_at DESC`,
    [userId]
  ).then((r) => r.rows)

  const movements = movementsRaw.map((m: { counterparty?: string | null; entity_canonical_name?: string | null }) => {
    const display = m.entity_canonical_name ?? (m.counterparty?.replace(/\s*\(deleted\)$/i, "") ?? m.counterparty)
    return { ...m, display_counterparty: display ?? m.counterparty }
  })

  const events = await query<{
    event_id: string
    date: string
    amount: string
    counterparty: string | null
    raw_description: string | null
    movement_class: string
    statement_impact: string | null
    movement_subclass: string | null
    event_type: string | null
    movement_mechanic: string | null
    review_status: string | null
    confidence: number
    source_summary: string
    evidence_count: number
  }>(
    `SELECT
       event_id,
       MIN(date)::text as date,
       (array_agg(amount ORDER BY created_at DESC))[1]::text as amount,
       (array_agg(counterparty ORDER BY (counterparty IS NOT NULL AND counterparty != '') DESC, created_at DESC))[1] as counterparty,
       (array_agg(raw_description ORDER BY (raw_description IS NOT NULL AND length(raw_description) > 0) DESC, created_at DESC))[1] as raw_description,
       (array_agg(movement_class ORDER BY created_at DESC))[1] as movement_class,
       (array_agg(statement_impact ORDER BY created_at DESC))[1] as statement_impact,
       (array_agg(movement_subclass ORDER BY created_at DESC))[1] as movement_subclass,
       (array_agg(event_type ORDER BY created_at DESC))[1] as event_type,
       (array_agg(movement_mechanic ORDER BY created_at DESC))[1] as movement_mechanic,
       (array_agg(review_status ORDER BY created_at DESC))[1] as review_status,
       (array_agg(confidence ORDER BY created_at DESC))[1]::real as confidence,
       string_agg(DISTINCT source, ',' ORDER BY source) as source_summary,
       COUNT(*)::int as evidence_count
     FROM movements
     WHERE user_id = $1 AND event_id IS NOT NULL
     GROUP BY event_id
     ORDER BY MIN(date) DESC`,
    [userId]
  ).then((r) => r.rows)

  const eventsWithoutGroup = await query<{
    id: string
    event_id: string | null
    date: string
    amount: string
    counterparty: string | null
    raw_description: string | null
    movement_class: string
    statement_impact: string | null
    movement_subclass: string | null
    event_type: string | null
    movement_mechanic: string | null
    review_status: string | null
    confidence: number
    source: string
  }>(
    `SELECT id, event_id, date::text, amount::text, counterparty, raw_description,
            movement_class, statement_impact, movement_subclass, event_type, movement_mechanic, review_status,
            confidence, source
     FROM movements WHERE user_id = $1 AND event_id IS NULL
     ORDER BY date DESC`,
    [userId]
  ).then((r) => r.rows)

  const displayByEventId = new Map<string, string | null>()
  const displayByMovementId = new Map<string, string | null>()
  for (const m of movements) {
    const d = m.display_counterparty ?? m.entity_canonical_name ?? (m.counterparty?.replace(/\s*\(deleted\)$/i, "") ?? m.counterparty)
    if (m.event_id) displayByEventId.set(m.event_id, d)
    displayByMovementId.set(m.id, d)
  }

  const allEvents = [
    ...events.map((e) => ({
      id: e.event_id,
      event_id: e.event_id,
      date: e.date,
      amount: e.amount,
      counterparty: e.counterparty,
      display_counterparty: displayByEventId.get(e.event_id) ?? (e.counterparty?.replace(/\s*\(deleted\)$/i, "") ?? e.counterparty),
      raw_description: e.raw_description,
      movement_class: e.movement_class,
      statement_impact: e.statement_impact,
      movement_subclass: e.movement_subclass,
      event_type: e.event_type,
      movement_mechanic: e.movement_mechanic,
      review_status: e.review_status,
      confidence: e.confidence,
      source: e.source_summary,
      evidence_count: e.evidence_count,
    })),
    ...eventsWithoutGroup.map((m) => ({
      id: m.id,
      event_id: m.event_id,
      date: m.date,
      amount: m.amount,
      counterparty: m.counterparty,
      display_counterparty: displayByMovementId.get(m.id) ?? (m.counterparty?.replace(/\s*\(deleted\)$/i, "") ?? m.counterparty),
      raw_description: m.raw_description,
      movement_class: m.movement_class,
      statement_impact: m.statement_impact,
      movement_subclass: m.movement_subclass,
      event_type: m.event_type,
      movement_mechanic: m.movement_mechanic,
      review_status: m.review_status,
      confidence: m.confidence,
      source: m.source,
      evidence_count: 1,
    })),
  ].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))

  const movementsForResponse = movements.map(({ entity_canonical_name, ...rest }) => rest)

  const summary = await query<{ movement_class: string; pnl_eligible: boolean; count: number; total_amount: string }>(
    `WITH event_amounts AS (
       SELECT COALESCE(event_id::text, id::text) as event_key,
              (array_agg(movement_class ORDER BY created_at DESC))[1] as movement_class,
              (array_agg(pnl_eligible ORDER BY created_at DESC))[1] as pnl_eligible,
              (array_agg(amount ORDER BY created_at DESC))[1] as amt
       FROM movements WHERE user_id = $1
       GROUP BY COALESCE(event_id::text, id::text)
     )
     SELECT movement_class, pnl_eligible, COUNT(*)::int as count, SUM(amt)::text as total_amount
     FROM event_amounts
     GROUP BY movement_class, pnl_eligible
     ORDER BY count DESC`,
    [userId]
  ).then((r) => r.rows)

  return NextResponse.json({ movements: movementsForResponse, events: allEvents, summary })
}
