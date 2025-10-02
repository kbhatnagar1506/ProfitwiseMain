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

  const movements = await query(
    `SELECT id, event_id, source, source_type, source_id, entity_id, date, amount,
            raw_description, counterparty, movement_class, pnl_eligible,
            statement_impact, movement_subclass,
            from_account, to_account, confidence, metadata, created_at
     FROM movements WHERE user_id = $1
     ORDER BY date DESC, created_at DESC`,
    [userId]
  ).then((r) => r.rows)

  const events = await query<{
    event_id: string
    date: string
    amount: string
    counterparty: string | null
    raw_description: string | null
    movement_class: string
    statement_impact: string | null
    movement_subclass: string | null
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
    confidence: number
    source: string
  }>(
    `SELECT id, event_id, date::text, amount::text, counterparty, raw_description,
            movement_class, statement_impact, movement_subclass, confidence, source
     FROM movements WHERE user_id = $1 AND event_id IS NULL
     ORDER BY date DESC`,
    [userId]
  ).then((r) => r.rows)

  const allEvents = [
    ...events.map((e) => ({
      id: e.event_id,
      event_id: e.event_id,
      date: e.date,
      amount: e.amount,
      counterparty: e.counterparty,
      raw_description: e.raw_description,
      movement_class: e.movement_class,
      statement_impact: e.statement_impact,
      movement_subclass: e.movement_subclass,
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
      raw_description: m.raw_description,
      movement_class: m.movement_class,
      statement_impact: m.statement_impact,
      movement_subclass: m.movement_subclass,
      confidence: m.confidence,
      source: m.source,
      evidence_count: 1,
    })),
  ].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))

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

  return NextResponse.json({ movements, events: allEvents, summary })
}
