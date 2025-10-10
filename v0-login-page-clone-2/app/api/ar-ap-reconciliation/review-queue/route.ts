import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { ensureMovementsSchema } from "@/lib/db"
import { fetchReviewQueue } from "@/lib/reconciliation-review-queue"

export async function GET(req: Request) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    await ensureMovementsSchema()
    const { searchParams } = new URL(req.url)
    const includeRecent = searchParams.get("includeRecent") !== "false"
    const data = await fetchReviewQueue(user.id, includeRecent)
    return NextResponse.json(data)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
