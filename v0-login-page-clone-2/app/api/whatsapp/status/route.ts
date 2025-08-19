import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { getWhatsAppStatusByUserId } from "@/lib/whatsapp-user"

export async function GET(_req: NextRequest) {
  const token = _req.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const status = await getWhatsAppStatusByUserId(user.id)
  return NextResponse.json({
    phone: status.phoneE164,
    verified: status.verified,
  })
}
