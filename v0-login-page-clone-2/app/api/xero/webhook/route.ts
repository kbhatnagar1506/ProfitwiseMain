import { NextRequest, NextResponse } from "next/server"
import { createHmac } from "crypto"
import { log } from "@/lib/logger"
import { getValidAccessToken, fetchXeroList } from "@/lib/xero"
import { upsertEntities } from "@/lib/xero-entity-store"

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

/** Xero eventCategory (uppercase) -> our entity type (Pascal). Only types we store. */
const EVENT_CATEGORY_TO_TYPE: Record<string, string> = {
  INVOICE: "Invoice",
  CONTACT: "Contact",
  ACCOUNT: "Account",
  PAYMENT: "Payment",
  CREDIT_NOTE: "CreditNote",
  BANK_TRANSACTION: "BankTransaction",
  MANUAL_JOURNAL: "ManualJournal",
  BILL: "Bill",
}

/** Extract API path from Xero resourceUrl (e.g. https://api.xero.com/api.xro/2.0/Invoices/guid -> /Invoices/guid). */
function pathFromResourceUrl(resourceUrl: string): string | null {
  try {
    const pathname = new URL(resourceUrl).pathname
    const path = pathname.replace(/^\/api\.xro\/2\.0/i, "") || "/"
    return path.startsWith("/") ? path : `/${path}`
  } catch {
    return null
  }
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

  let payload: { events?: Array<{ resourceUrl?: string; resourceId?: string; eventCategory?: string; tenantId?: string }> }
  try {
    payload = JSON.parse(bodyRaw.toString("utf8")) as typeof payload
  } catch {
    log("webhook.parse.failed", { payloadSize: bodyRaw.length }, "xero")
    return NextResponse.json({ received: true }, { status: 200 })
  }

  const events = Array.isArray(payload.events) ? payload.events : []
  log("webhook.received", { payloadSize: bodyRaw.length, eventCount: events.length }, "xero")

  if (events.length > 0) {
    void (async () => {
      for (const ev of events) {
        const tenantId = ev.tenantId != null ? String(ev.tenantId) : undefined
        const resourceUrl = ev.resourceUrl != null ? String(ev.resourceUrl) : undefined
        const eventCategory = ev.eventCategory != null ? String(ev.eventCategory) : undefined
        if (!tenantId || !resourceUrl || !eventCategory) {
          log("webhook.event.skipped", { reason: "missing_fields", tenantId: !!tenantId, resourceUrl: !!resourceUrl, eventCategory: !!eventCategory }, "xero")
          continue
        }
        const entityType = EVENT_CATEGORY_TO_TYPE[eventCategory]
        if (!entityType) {
          log("webhook.event.skipped", { reason: "unsupported_category", eventCategory }, "xero")
          continue
        }
        const path = pathFromResourceUrl(resourceUrl)
        if (!path) {
          log("webhook.event.skipped", { reason: "invalid_resource_url", resourceUrl }, "xero")
          continue
        }
        try {
          const accessToken = await getValidAccessToken(tenantId)
          const items = await fetchXeroList<unknown>(accessToken, tenantId, path)
          if (items.length > 0) {
            const count = await upsertEntities(tenantId, entityType, items)
            log("webhook.entity.upserted", { tenantId, entityType, count, resourceId: ev.resourceId }, "xero")
          }
        } catch (err) {
          log("webhook.entity_update.failed", { tenantId, entityType, resourceId: ev.resourceId, error: String(err) }, "xero")
        }
      }
    })()
  }

  return NextResponse.json({ received: true }, { status: 200 })
}
