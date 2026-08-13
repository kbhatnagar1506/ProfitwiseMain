import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query } from "@/lib/db"

export async function GET() {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const userId = user.id
    const today = new Date().toISOString().split("T")[0]

    const [reviewRow, overdueRow, alertRow] = await Promise.all([
      query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM movements
         WHERE user_id = $1 AND review_needed = true AND duplicate_of IS NULL`,
        [userId]
      ).then((r) => r.rows[0]),

      query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM movements
         WHERE user_id = $1 AND direction = 'inflow' AND movement_type = 'receivable'
           AND status NOT IN ('paid','cancelled') AND expected_date < $2 AND duplicate_of IS NULL`,
        [userId, today]
      ).then((r) => r.rows[0]),

      query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM movements
         WHERE user_id = $1 AND movement_type = 'alert' AND duplicate_of IS NULL
           AND (metadata->>'dismissed')::boolean IS DISTINCT FROM true`,
        [userId]
      ).then((r) => r.rows[0]),
    ])

    return NextResponse.json({
      review_queue: parseInt(reviewRow?.count ?? "0", 10),
      chase_queue: parseInt(overdueRow?.count ?? "0", 10),
      alerts: parseInt(alertRow?.count ?? "0", 10),
    })
  } catch {
    return NextResponse.json({ review_queue: 0, chase_queue: 0, alerts: 0 })
  }
}
