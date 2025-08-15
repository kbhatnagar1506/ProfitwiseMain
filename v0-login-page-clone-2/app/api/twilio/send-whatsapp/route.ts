import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { getTwilio, getWhatsAppFrom } from "@/lib/twilio"

/**
 * POST /api/twilio/send-whatsapp
 * Body: { to: string (e.g. "whatsapp:+15551234567"), body: string }
 * Requires session. Sends WhatsApp message from TWILIO_WHATSAPP_FROM.
 */
export async function POST(req: NextRequest) {
  const token = req.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: { to?: string; body?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const to = typeof body.to === "string" ? body.to.trim() : ""
  const text = typeof body.body === "string" ? body.body.trim() : ""
  if (!to || !text) {
    return NextResponse.json(
      { error: "to and body are required" },
      { status: 400 }
    )
  }

  const client = getTwilio()
  const from = getWhatsAppFrom()
  if (!client || !from) {
    return NextResponse.json(
      { error: "Twilio WhatsApp not configured" },
      { status: 503 }
    )
  }

  const toFormatted = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`

  try {
    const message = await client.messages.create({
      from,
      to: toFormatted,
      body: text,
    })
    return NextResponse.json({
      sid: message.sid,
      status: message.status,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Twilio error"
    return NextResponse.json(
      { error: "Send failed", detail: message },
      { status: 502 }
    )
  }
}
