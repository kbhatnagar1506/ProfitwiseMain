import { NextRequest, NextResponse } from "next/server"
import { log } from "@/lib/logger"
import { getEntityById, getAllForEntity, type QBOEntityType } from "@/lib/quickbooks"
import { upsertEntities, deleteEntity } from "@/lib/qbo-entity-store"

export async function GET(request: NextRequest) {
  log("webhook.verify.challenge.received")
  const verifier = process.env.QUICKBOOKS_WEBHOOK_VERIFIER
  if (!verifier) {
    log("webhook.verify.challenge.failed", { reason: "missing_verifier" })
    return NextResponse.json({ error: "Webhook not configured" }, { status: 500 })
  }
  log("webhook.verify.challenge.responded")
  return new NextResponse(verifier, {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  })
}

export async function POST(request: NextRequest) {
  const verifier = process.env.QUICKBOOKS_WEBHOOK_VERIFIER
  if (!verifier) {
    log("webhook.verify.rejected", { reason: "missing_verifier" })
    return NextResponse.json({ error: "Webhook not configured" }, { status: 500 })
  }

  let body: string
  try {
    body = await request.text()
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 })
  }

  const payloadSize = body?.length ?? 0
  let eventCount = 0
  try {
    const parsed = body ? JSON.parse(body) : null
    if (Array.isArray(parsed)) {
      eventCount = parsed.length
    } else if (parsed && typeof parsed === "object" && Array.isArray(parsed.eventNotifications)) {
      eventCount = parsed.eventNotifications.length
    }
  } catch {
    // ignore parse errors for count
  }

  log("webhook.received", { payloadSize, eventCount })

  const signatureHeader = request.headers.get("intuit-signature") ?? request.headers.get("Intuit-Signature")
  if (signatureHeader) {
    const crypto = await import("crypto")
    const clientSecret = process.env.QUICKBOOKS_CLIENT_SECRET
    const verifierToken = process.env.QUICKBOOKS_WEBHOOK_VERIFIER
    const signature = signatureHeader.replace(/^sha256=/i, "").trim()

    const payloadsToTry: string[] = [body]
    try {
      const parsed = JSON.parse(body)
      payloadsToTry.push(JSON.stringify(parsed))
    } catch {
      // keep only raw body
    }

    const verify = (key: string): boolean => {
      for (const payload of payloadsToTry) {
        const h = crypto.createHmac("sha256", key)
        h.update(payload, "utf8")
        const base64 = h.digest("base64")
        const hex = h.digest("hex")
        if (base64 === signature || hex === signature) return true
      }
      return false
    }

    const withClientSecret = clientSecret && verify(clientSecret)
    const withVerifier = verifierToken && verify(verifierToken)
    if (!withClientSecret && !withVerifier) {
      log("webhook.verify.failed", { reason: "signature_mismatch" })
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
    }
  }

  log("webhook.verify.succeeded")

  type EntityChange = { realmId: string; name: string; id: string; operation: string }
  const changes: EntityChange[] = []
  const realmsTouched = new Set<string>()

  try {
    const parsed = body ? JSON.parse(body) : null
    if (Array.isArray(parsed) && parsed.length > 0) {
      for (const item of parsed as Array<{ intuitaccountid?: string; eventNotifications?: Array<{ realmId?: string; dataChangeEvent?: { entities?: Array<{ name?: string; id?: string; operation?: string }> } }> }>) {
        const realmId = item?.intuitaccountid
        const notifications = item?.eventNotifications
        if (realmId && Array.isArray(notifications)) {
          realmsTouched.add(realmId)
          for (const n of notifications) {
            const entities = n?.dataChangeEvent?.entities ?? []
            for (const e of entities) {
              if (e?.name && e?.id && e?.operation) {
                changes.push({ realmId, name: e.name, id: String(e.id), operation: e.operation })
              }
            }
          }
        }
      }
    } else if (parsed && typeof parsed === "object" && Array.isArray(parsed.eventNotifications)) {
      const notifications = parsed.eventNotifications as Array<{
        realmId?: string
        dataChangeEvent?: { entities?: Array<{ name?: string; id?: string; operation?: string }> }
      }>
      for (const n of notifications) {
        const realmId = n?.realmId
        const entities = n?.dataChangeEvent?.entities ?? []
        if (realmId) {
          realmsTouched.add(realmId)
          for (const e of entities) {
            if (e?.name && e?.id && e?.operation) {
              changes.push({ realmId, name: e.name, id: String(e.id), operation: e.operation })
            }
          }
        }
      }
    }
  } catch {
    // ignore parse for changes
  }

  if (changes.length > 0) {
    log("webhook.entity_changes", { count: changes.length, realmIds: [...new Set(changes.map((c) => c.realmId))] }, "qbo")
    void (async () => {
      for (const { realmId, name, id, operation } of changes) {
        try {
          const op = String(operation).toLowerCase()
          if (op === "delete") {
            await deleteEntity(realmId, name, id)
          } else {
            const entity = await getEntityById(realmId, name, id)
            if (entity) {
              await upsertEntities(realmId, name, [entity])
            }
          }
        } catch (err) {
          log("webhook.entity_update.failed", { realmId, name, id, operation, error: String(err) }, "qbo")
        }
      }
    })()
  } else if (realmsTouched.size > 0) {
    // No per-entity change payloads parsed, but we know which realms were touched.
    // As a fallback, resync all invoices for those realms so new invoices (like 1003) are up to date.
    const invoiceType = "Invoice" as QBOEntityType
    void (async () => {
      for (const realmId of realmsTouched) {
        try {
          const items = await getAllForEntity(realmId, invoiceType)
          const count = await upsertEntities(realmId, invoiceType, items)
          log("webhook.invoice_resync.succeeded", { realmId, count }, "qbo")
        } catch (err) {
          log(
            "webhook.invoice_resync.failed",
            { realmId, error: err instanceof Error ? err.message : String(err) },
            "qbo"
          )
        }
      }
    })()
  }

  return NextResponse.json({ received: true }, { status: 200 })
}
