import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { seedIdentityGraph } from "@/lib/identity-seed"
import { query, ensureIdentitySchema } from "@/lib/db"
import { log } from "@/lib/logger"

export async function POST() {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  await ensureIdentitySchema()

  const { rows: existing } = await query<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM entities WHERE user_id = $1",
    [user.id]
  )
  const alreadySeeded = (existing[0]?.count ?? 0) > 0

  // Fire-and-forget: kick off the seed in the background so we don't hit Heroku's 30s timeout.
  seedIdentityGraph(user.id).catch((err) => {
    log("identity.seed.background_error", { userId: user.id, error: err instanceof Error ? err.message : String(err) }, "identity")
  })

  return NextResponse.json({ ok: true, status: alreadySeeded ? "reseeding" : "seeding" })
}
