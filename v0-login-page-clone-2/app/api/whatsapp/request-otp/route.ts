import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { ensureWhatsAppSchema, query } from "@/lib/db"
import { getTwilio, getWhatsAppFrom, getTwilioConfigHint } from "@/lib/twilio"
import { normalizePhoneE164, setPendingOtp } from "@/lib/whatsapp-user"

const OTP_EXPIRY_MINUTES = 10
const OTP_LENGTH = 6

function generateOtp(): string {
  const digits = []
  for (let i = 0; i < OTP_LENGTH; i++) {
    digits.push(Math.floor(Math.random() * 10))
  }
  return digits.join("")
}

export async function POST(req: NextRequest) {
  const token = req.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: { phone?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }
  const raw = typeof body.phone === "string" ? body.phone.trim() : ""
  const phoneE164 = normalizePhoneE164(raw)
  if (!phoneE164 || phoneE164.length < 10) {
    return NextResponse.json({ error: "Valid phone number required" }, { status: 400 })
  }

  await ensureWhatsAppSchema()
  const { rows: existing } = await query<{ user_id: string }>(
    "SELECT user_id FROM user_whatsapp WHERE phone_e164 = $1",
    [phoneE164]
  )
  if (existing[0] && existing[0].user_id !== user.id) {
    return NextResponse.json(
      { error: "This number is already linked to another account" },
      { status: 409 }
    )
  }

  const otp = generateOtp()
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000)
  await setPendingOtp(user.id, phoneE164, otp, expiresAt)

  const client = getTwilio()
  const from = getWhatsAppFrom()
  if (!client || !from) {
    return NextResponse.json(
      { error: "WhatsApp not configured", hint: getTwilioConfigHint() },
      { status: 503 }
    )
  }

  const to = phoneE164.startsWith("+") ? `whatsapp:${phoneE164}` : `whatsapp:+${phoneE164}`
  const messageBody = `Your ProfitWise verification code is: ${otp}. It expires in ${OTP_EXPIRY_MINUTES} minutes.`
  try {
    await client.messages.create({
      from,
      to,
      body: messageBody,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Send failed"
    return NextResponse.json({ error: "Could not send code", detail: msg }, { status: 502 })
  }

  return NextResponse.json({ ok: true })
}
