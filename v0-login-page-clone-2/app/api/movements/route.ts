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
    `SELECT id, source, source_type, source_id, entity_id, date, amount,
            raw_description, counterparty, movement_class, pnl_eligible,
            from_account, to_account, confidence, metadata, created_at
     FROM movements WHERE user_id = $1
     ORDER BY date DESC, created_at DESC`,
    [userId]
  ).then((r) => r.rows)

  const summary = await query<{ movement_class: string; pnl_eligible: boolean; count: number; total_amount: string }>(
    `SELECT movement_class, pnl_eligible, COUNT(*)::int as count, SUM(amount)::text as total_amount
     FROM movements WHERE user_id = $1
     GROUP BY movement_class, pnl_eligible
     ORDER BY count DESC`,
    [userId]
  ).then((r) => r.rows)

  return NextResponse.json({ movements, summary })
}
