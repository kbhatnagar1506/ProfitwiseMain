import { NextRequest, NextResponse } from "next/server"
import { createHmac, timingSafeEqual } from "crypto"
import { log, warn, error } from "@/lib/logger"

function verifyStripeSignature(rawBody: Buffer, signatureHeader: string, secret: string): boolean {
  const parts = signatureHeader.split(",")
  const sigMap: Record<string, string> = {}

  for (const part of parts) {
    const [k, v] = part.split("=")
    if (k && v) {
      sigMap[k] = v
    }
  }

  const timestamp = sigMap["t"]
  const v1 = sigMap["v1"]

  if (!timestamp || !v1) {
    return false
  }

  const payload = `${timestamp}.${rawBody.toString("utf8")}`
  const expected = createHmac("sha256", secret).update(payload).digest("hex")

  const expectedBuf = Buffer.from(expected, "hex")
  const v1Buf = Buffer.from(v1, "hex")

  if (expectedBuf.length !== v1Buf.length) {
    return false
  }

  return timingSafeEqual(expectedBuf, v1Buf)
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET

  if (!secret) {
    error("stripe.webhook.misconfigured_no_secret", undefined, "stripe")
    return NextResponse.json({ error: "Webhook not configured" }, { status: 500 })
  }

  const sigHeader =
    request.headers.get("stripe-signature") ?? request.headers.get("Stripe-Signature")

  if (!sigHeader) {
    warn("stripe.webhook.missing_signature_header", undefined, "stripe")
    return NextResponse.json({ error: "Missing signature" }, { status: 400 })
  }

  const rawBody = Buffer.from(await request.arrayBuffer())

  if (!verifyStripeSignature(rawBody, sigHeader, secret)) {
    warn("stripe.webhook.signature_verification_failed", undefined, "stripe")
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 })
  }

  let event: any
  try {
    event = JSON.parse(rawBody.toString("utf8"))
  } catch (err) {
    error("stripe.webhook.invalid_json", err, "stripe")
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  log(
    "stripe.webhook.received",
    {
      id: event.id,
      type: event.type,
      api_version: event.api_version,
      account: event.account ?? null,
      livemode: event.livemode,
    },
    "stripe"
  )

  // TODO: In a follow-up step, route specific event types (invoices, payouts,
  // customers, subscriptions, balance transactions, etc.) into dedicated
  // upsert functions and tables so we can keep Stripe data in sync.

  return NextResponse.json({ received: true }, { status: 200 })
}

