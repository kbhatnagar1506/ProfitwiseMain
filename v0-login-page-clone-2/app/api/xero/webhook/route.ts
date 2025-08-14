import { NextRequest, NextResponse } from "next/server"
import { createHmac } from "crypto"
import { log } from "@/lib/logger"

function verifySignature(bodyRaw: Buffer, signatureHeader: string, key: string): boolean {
  const sig = signatureHeader.trim()
  const expectedStringKey = createHmac("sha256", key).update(bodyRaw).digest("base64")
  if (expectedStringKey === sig) return true
  try {
    const keyDecoded = Buffer.from(key, "base64")
    if (keyDecoded.length > 0) {
      const expectedDecodedKey = createHmac("sha256", keyDecoded).update(bodyRaw).digest("base64")
      if (expectedDecodedKey === sig) return true
    }
  } catch {
    // key not valid base64
  }
  return false
}

export async function POST(request: NextRequest) {
  const signingKey = process.env.XERO_WEBHOOK_KEY
  if (!signingKey) {
    log("webhook.verify.rejected", { reason: "missing_signing_key" }, "xero")
    return NextResponse.json({ error: "Webhook not configured" }, { status: 500 })
  }

  let bodyRaw: Buffer
  try {
    const ab = await request.arrayBuffer()
    bodyRaw = Buffer.from(ab)
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 })
  }

  const signatureHeader = request.headers.get("x-xero-signature") ?? request.headers.get("X-Xero-Signature")
  if (!signatureHeader) {
    log("webhook.verify.failed", { reason: "missing_signature" }, "xero")
    return NextResponse.json({ error: "Missing signature" }, { status: 401 })
  }

  if (!verifySignature(bodyRaw, signatureHeader, signingKey)) {
    log("webhook.verify.failed", { reason: "signature_mismatch", bodyLen: bodyRaw.length, sigLen: signatureHeader.length }, "xero")
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
  }

  log("webhook.received", { payloadSize: bodyRaw.length }, "xero")
  return NextResponse.json({ received: true }, { status: 200 })
}
