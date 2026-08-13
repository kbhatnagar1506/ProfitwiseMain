import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { classifyMovements } from "@/lib/movement-classify"
import { query, ensureMovementsSchema } from "@/lib/db"
import { log } from "@/lib/logger"

export async function POST(req: Request) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  await ensureMovementsSchema()

  const { rows: existing } = await query<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM movements WHERE user_id = $1",
    [user.id]
  )
  const count = existing[0]?.count ?? 0

  const url = new URL(req.url)
  const force = url.searchParams.get("force") === "true"

  if (count > 0 && !force) {
    return NextResponse.json({ ok: true, status: "already_classified", count })
  }

  classifyMovements(user.id).catch((err) => {
    log("movements.classify.background_error", { userId: user.id, error: err instanceof Error ? err.message : String(err) }, "movements")
  })

  return NextResponse.json({ ok: true, status: count > 0 ? "reclassifying" : "classifying" })
}
