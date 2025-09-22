import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { tagMovements } from "@/lib/movement-tag-enrich"

export async function POST() {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    const { tags, stats, unresolved_impact, owner_dependency, working_capital } = await tagMovements(user.id)
    return NextResponse.json({ tagged: tags.length, stats, unresolved_impact, owner_dependency, working_capital })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
