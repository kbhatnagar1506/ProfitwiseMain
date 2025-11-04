import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import type { MovementDetailResponse } from "@/lib/movement-detail-types"
import { generateMovementExplanation } from "@/lib/movement-explain"

export async function POST(req: Request) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const detail = (body?.detail ?? null) as MovementDetailResponse | null
  if (!detail) return NextResponse.json({ error: "detail payload required" }, { status: 400 })

  const explanation = await generateMovementExplanation(user.id, detail)
  return NextResponse.json({ explanation })
}
