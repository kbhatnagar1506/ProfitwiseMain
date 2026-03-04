import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { ensureMovementsSchema, query } from "@/lib/db"

export async function GET(request: Request) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const accountCode = searchParams.get("code")

  if (!accountCode) {
    return NextResponse.json({ error: "account code required" }, { status: 400 })
  }

  await ensureMovementsSchema()

  const relRows = await query<{ from_id: string; to_id: string; relationship: string }>(
    `SELECT from_entity_id::text AS from_id, to_entity_id::text AS to_id, relationship
     FROM entity_relationships WHERE from_entity_id IN (
       SELECT DISTINCT entity_id FROM movement_attributions WHERE user_id = $1
     ) LIMIT 50`,
    [user.id]
  )

  return NextResponse.json({
    account_code: accountCode,
    relationships: relRows.rows,
    total_related_parties: relRows.rows.length,
  })
}
