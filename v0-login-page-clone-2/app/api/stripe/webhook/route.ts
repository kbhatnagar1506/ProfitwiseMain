import { NextRequest, NextResponse } from "next/server"
import { createHmac, timingSafeEqual } from "crypto"
import { log, warn, error } from "@/lib/logger"
import { upsertStripeEntities, deleteStripeEntity } from "@/lib/stripe-entity-store"

const STRIPE_ENTITY_TYPES = new Set([
  "customer",
  "invoice",
  "subscription",
  "payment_intent",
  "payout",
  "balance_transaction",
])

function getEntityTypeAndAction(
  eventType: string
): { entityType: string; isDelete: boolean } | null {
  const parts = typeof eventType === "string" ? eventType.split(".") : []
  const resource = parts[0]
  const action = parts[1] ?? ""
  if (!resource || !STRIPE_ENTITY_TYPES.has(resource)) return null
  return { entityType: resource, isDelete: action === "deleted" }
}

function getStripeAccountId(event: { account?: string; data?: { object?: { account?: string } } }): string | null {
  if (event.account && typeof event.account === "string") return event.account
  const obj = event.data?.object
  if (obj && typeof obj === "object" && typeof (obj as Record<string, unknown>).account === "string") {
    return (obj as Record<string, unknown>).account as string
  }
  return null
}

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
  const secretEnv = process.env.STRIPE_WEBHOOK_SECRET
  const secrets = secretEnv
    ? secretEnv.split(",").map((s) => s.trim()).filter(Boolean)
    : []

  if (secrets.length === 0) {
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

  const valid = secrets.some((secret) => verifyStripeSignature(rawBody, sigHeader, secret))
  if (!valid) {
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

  const accountId = getStripeAccountId(event)
  const parsed = getEntityTypeAndAction(event.type ?? "")
  const obj = event.data?.object

  if (accountId && parsed && obj && typeof obj === "object") {
    const entityId = (obj as Record<string, unknown>).id
    if (typeof entityId === "string") {
      try {
        if (parsed.isDelete) {
          await deleteStripeEntity(accountId, parsed.entityType, entityId)
          log("stripe.webhook.entity.deleted", { accountId, entityType: parsed.entityType, entityId }, "stripe")
        } else {
          const count = await upsertStripeEntities(accountId, parsed.entityType, [obj])
          log("stripe.webhook.entity.upserted", { accountId, entityType: parsed.entityType, entityId, count }, "stripe")
        }
      } catch (err) {
        error("stripe.webhook.persist.failed", { eventType: event.type, accountId, error: err }, "stripe")
      }
    }
  }

  return NextResponse.json({ received: true }, { status: 200 })
}

