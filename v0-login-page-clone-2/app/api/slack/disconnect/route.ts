import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { disconnectSlack } from "@/lib/slack-user"

export async function POST(req: NextRequest) {
  const token = req.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  await disconnectSlack(user.id)
  return NextResponse.json({ ok: true })
}
