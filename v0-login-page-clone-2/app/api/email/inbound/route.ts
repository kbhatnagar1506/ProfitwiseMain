import { NextRequest, NextResponse } from "next/server"
import { gcpSaveInboundEmail } from "@/lib/entity-store-gcp"
import { log } from "@/lib/logger"

function generateStorageKey(from?: string | null, to?: string | null, messageId?: string | null): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-")
  const parts = [
    ts,
    from ? String(from).slice(0, 80) : "",
    to ? String(to).slice(0, 80) : "",
    messageId ? String(messageId).slice(0, 80) : "",
  ].filter(Boolean)
  return parts.join("_")
}

export async function POST(req: NextRequest) {
  let payload: unknown
  try {
    // SendGrid Inbound Parse can send either application/json or form-data;
    // for now we assume JSON (we can extend to form-data later).
    payload = await req.json()
  } catch {
    payload = null
  }

  // Try to pull a few useful fields for logging and key generation
  const body = (payload ?? {}) as Record<string, unknown>
  const from = (body.from as string | undefined) ?? null
  const to = (body.to as string | undefined) ?? null
  const messageId =
    (body["Message-ID"] as string | undefined) ??
    (body["message-id"] as string | undefined) ??
    (body.message_id as string | undefined) ??
    null

  const key = generateStorageKey(from, to, messageId)

  try {
    await gcpSaveInboundEmail(key, payload ?? {})
    log("email.inbound.received", { key, from, to }, "system")
  } catch (err) {
    log("email.inbound.save_failed", { error: err instanceof Error ? err.message : String(err) }, "system")
    // We still respond 200 so SendGrid does not retry endlessly; we can tighten later.
  }

  return NextResponse.json({ ok: true })
}

