import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { disconnectWhatsApp } from "@/lib/whatsapp-user"

/** POST /api/whatsapp/disconnect — remove linked WhatsApp number for current user (so they can link another). */
export async function POST(req: NextRequest) {
  const token = req.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  await disconnectWhatsApp(user.id)
  return NextResponse.json({ ok: true })
}
