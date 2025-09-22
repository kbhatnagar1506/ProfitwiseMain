import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { computeBusinessState } from "@/lib/state"

export async function GET() {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    const state = await computeBusinessState(user.id)
    return NextResponse.json(state)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
