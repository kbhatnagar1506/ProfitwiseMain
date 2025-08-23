import { NextRequest, NextResponse } from "next/server"
import { createHash, timingSafeEqual } from "crypto"
import * as jose from "jose"
import { log } from "@/lib/logger"
import { getPlaidClient } from "@/lib/plaid"
import { mapAndDelete, mapAndUpsert } from "@/lib/plaid-persistence"
import { getPlaidItem, updatePlaidItemCursor } from "@/lib/plaid-item-store"
import { updatePlaidWebhookLast } from "@/lib/db"

type PlaidWebhookPayload = {
  webhook_type?: string
  webhook_code?: string
  item_id?: string
  [key: string]: unknown
}

const keyCache = new Map<string, jose.JWK>()

async function verifyPlaidWebhook(body: string, verificationHeader: string | null): Promise<boolean> {
  if (!verificationHeader) return true
  const client = getPlaidClient()
  let decoded: { header: { alg?: string; kid?: string }; payload?: { request_body_sha256?: string; iat?: number } }
  try {
    const parts = verificationHeader.split(".")
    if (parts.length !== 3) return false
    const headerJson = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"))
    const payloadB64 = parts[1]
    decoded = {
      header: headerJson,
      payload: JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")),
    }
  } catch {
    return false
  }
  if (decoded.header?.alg !== "ES256") return false
  const kid = decoded.header.kid
  if (!kid) return false

  let key = keyCache.get(kid)
  if (!key) {
    try {
      const res = await client.webhookVerificationKeyGet({ key_id: kid })
      key = res.data.key as jose.JWK
      keyCache.set(kid, key)
    } catch {
      return false
    }
  }

  try {
    const publicKey = await jose.importJWK(key, "ES256")
    const { payload } = await jose.jwtVerify(verificationHeader, publicKey, { maxTokenAge: "5 min" })
    const claimedHash = payload.request_body_sha256
    if (typeof claimedHash !== "string") return false
    const actualHash = createHash("sha256").update(body, "utf8").digest("hex")
    if (actualHash.length !== claimedHash.length) return false
    return timingSafeEqual(Buffer.from(actualHash, "utf8"), Buffer.from(claimedHash, "utf8"))
  } catch {
    return false
  }
}

async function runTransactionsSync(itemId: string): Promise<void> {
  const client = getPlaidClient()
  try {
    let hasMore = true
    while (hasMore) {
      const item = await getPlaidItem(itemId)
      if (!item) {
        log("webhook.sync.skipped", { itemId, reason: "item_not_found" }, "plaid")
        return
      }
      const cursor = item.cursor ?? undefined
      const response = await client.transactionsSync({
        access_token: item.access_token,
        cursor,
      })
      const nextCursor = response.data.next_cursor
      if (nextCursor) await updatePlaidItemCursor(itemId, nextCursor)
      const added = response.data.added ?? []
      const modified = response.data.modified ?? []
      const removed = response.data.removed ?? []
      await mapAndUpsert(itemId, added, modified)
      await mapAndDelete(itemId, removed)
      log("webhook.sync.page", { itemId, added: added.length, modified: modified.length, removed: removed.length, hasMore: response.data.has_more }, "plaid")
      hasMore = response.data.has_more ?? false
    }
  } catch (err) {
    log("webhook.sync.failed", { itemId, error: err instanceof Error ? err.message : String(err) }, "plaid")
  }
}

export async function POST(request: NextRequest) {
  let body: string
  try {
    body = await request.text()
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 })
  }

  const verificationHeader =
    request.headers.get("plaid-verification") ?? request.headers.get("Plaid-Verification")
  if (verificationHeader) {
    try {
      if (!(await verifyPlaidWebhook(body, verificationHeader))) {
        log("webhook.verify.failed", { reason: "signature_mismatch" }, "plaid")
        return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
      }
    } catch {
      log("webhook.verify.failed", { reason: "verification_error" }, "plaid")
      return NextResponse.json({ error: "Verification error" }, { status: 401 })
    }
  }

  let payload: PlaidWebhookPayload
  try {
    payload = body ? JSON.parse(body) : {}
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const webhookType = payload.webhook_type
  const webhookCode = payload.webhook_code
  const itemId = payload.item_id

  log("webhook.received", { webhookType, webhookCode, itemId }, "plaid")
  try {
    await updatePlaidWebhookLast(
      new Date(),
      typeof webhookType === "string" ? webhookType : null,
      typeof webhookCode === "string" ? webhookCode : null,
      typeof itemId === "string" ? itemId : null
    )
  } catch {
    // ignore if DB unavailable (e.g. dev)
  }

  if (
    webhookType === "TRANSACTIONS" &&
    webhookCode === "SYNC_UPDATES_AVAILABLE" &&
    typeof itemId === "string"
  ) {
    runTransactionsSync(itemId).catch(() => {})
  }

  return NextResponse.json({ received: true }, { status: 200 })
}
