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
    `SELECT m.id, m.direction, m.amount, m.date, m.movement_type, m.pnl_eligible,
            m.provenance, m.cash_account_id, m.counterparty, m.counterparty_entity_id,
            m.counterparty_entity_type, m.linked_internal_account_id,
            m.confidence, m.review_needed, m.raw_description, m.metadata, m.created_at,
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

  const summary = await query<{
    movement_type: string; pnl_eligible: boolean; count: number; total_amount: string
  }>(
    `SELECT movement_type, pnl_eligible, COUNT(*)::int as count, SUM(amount)::text as total_amount
     FROM movements WHERE user_id = $1
     GROUP BY movement_type, pnl_eligible
     ORDER BY count DESC`,
    [userId]
  ).then((r) => r.rows)

  return NextResponse.json({ movements, summary })
}
