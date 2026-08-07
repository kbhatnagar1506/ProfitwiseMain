import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { getSlackStatusByUserId } from "@/lib/slack-user"

export async function GET(req: NextRequest) {
  const token = req.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const status = await getSlackStatusByUserId(user.id)
  return NextResponse.json({ connected: status.connected, slackTeamId: status.slackTeamId ?? null })
}
