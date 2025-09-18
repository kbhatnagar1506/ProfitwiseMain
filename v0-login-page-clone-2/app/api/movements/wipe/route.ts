import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query, ensureMovementsSchema } from "@/lib/db"

export async function POST() {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  await ensureMovementsSchema()
  // Observations cascade-delete via FK
  await query("DELETE FROM movements WHERE user_id = $1", [user.id])
  await query("DELETE FROM movement_families WHERE user_id = $1", [user.id])

  return NextResponse.json({ ok: true })
}
