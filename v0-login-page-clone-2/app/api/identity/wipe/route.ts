import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query, ensureIdentitySchema } from "@/lib/db"

export async function POST() {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  await ensureIdentitySchema()

  await query("DELETE FROM identity_assertions WHERE entity_id IN (SELECT id FROM entities WHERE user_id = $1)", [user.id])
  await query("DELETE FROM identity_resolution_decisions WHERE user_id = $1", [user.id])
  await query("DELETE FROM account_ownership WHERE entity_id IN (SELECT id FROM entities WHERE user_id = $1)", [user.id])
  await query("DELETE FROM entity_relationships WHERE from_entity_id IN (SELECT id FROM entities WHERE user_id = $1) OR to_entity_id IN (SELECT id FROM entities WHERE user_id = $1)", [user.id])
  await query("DELETE FROM entity_aliases WHERE entity_id IN (SELECT id FROM entities WHERE user_id = $1)", [user.id])
  await query("DELETE FROM entities WHERE user_id = $1", [user.id])

  return NextResponse.json({ ok: true })
}
