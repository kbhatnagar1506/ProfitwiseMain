import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { ensureWhatsAppSchema, query } from "@/lib/db"
import { getWhatsAppStatusByUserId, markWhatsAppVerified } from "@/lib/whatsapp-user"

export async function POST(req: NextRequest) {
  const token = req.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: { code?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }
  const code = typeof body.code === "string" ? body.code.replace(/\D/g, "") : ""
  if (!code || code.length !== 6) {
    return NextResponse.json({ error: "Enter the 6-digit code" }, { status: 400 })
  }

  await ensureWhatsAppSchema()
  const { rows } = await query<{ otp_code: string; otp_expires_at: Date }>(
    "SELECT otp_code, otp_expires_at FROM user_whatsapp WHERE user_id = $1 AND verified_at IS NULL",
    [user.id]
  )
  const row = rows[0]
  if (!row || row.otp_code !== code) {
    return NextResponse.json({ error: "Invalid or expired code" }, { status: 400 })
  }
  if (new Date(row.otp_expires_at) < new Date()) {
    return NextResponse.json({ error: "Code expired. Request a new one." }, { status: 400 })
  }

  await markWhatsAppVerified(user.id)
  const status = await getWhatsAppStatusByUserId(user.id)
  return NextResponse.json({ ok: true, phone: status.phoneE164, verified: status.verified })
}
