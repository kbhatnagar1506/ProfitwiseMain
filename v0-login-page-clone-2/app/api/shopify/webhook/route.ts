import { NextRequest, NextResponse } from "next/server"
import crypto from "crypto"
import { error as logError, log, warn } from "@/lib/logger"
import { isValidWebhookHmac, normalizeShopDomain } from "@/lib/shopify"
import { resolveConnectionByShopDomain, storeWebhookEvent } from "@/lib/shopify-token-store"
import { processWebhookEvent, queueWebhookProcessing } from "@/lib/shopify-sync"
import { isShopifyWebhookIntakeEnabled } from "@/lib/shopify-flags"

function webhookSecret(): string {
  return process.env.SHOPIFY_WEBHOOK_SHARED_SECRET ?? ""
}

export async function POST(request: NextRequest) {
  if (!isShopifyWebhookIntakeEnabled()) {
    return NextResponse.json({ error: "Shopify webhook intake disabled" }, { status: 503 })
  }
  const rawBody = await request.text()
  const receivedHmac = request.headers.get("x-shopify-hmac-sha256")
  const topic = request.headers.get("x-shopify-topic") ?? "unknown"
  const eventId = request.headers.get("x-shopify-event-id") ?? request.headers.get("x-shopify-webhook-id") ?? crypto.randomUUID()
  const shopDomain = normalizeShopDomain(request.headers.get("x-shopify-shop-domain") ?? "")
  if (!shopDomain) return NextResponse.json({ error: "missing_shop_domain" }, { status: 400 })

  const secret = webhookSecret()
  if (!secret || !isValidWebhookHmac(rawBody, receivedHmac, secret)) {
    warn("shopify.webhook.rejected", { topic, shopDomain, reason: "invalid_hmac" }, "shopify")
    return NextResponse.json({ error: "invalid_hmac" }, { status: 401 })
  }

  const resolved = await resolveConnectionByShopDomain(shopDomain)
  if (!resolved) {
    warn("shopify.webhook.rejected", { topic, shopDomain, reason: "unknown_connection" }, "shopify")
    return NextResponse.json({ error: "unknown_connection" }, { status: 404 })
  }

  const payload = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {}
  const headers: Record<string, string> = {}
  request.headers.forEach((value, key) => {
    headers[key] = value
  })

  const stored = await storeWebhookEvent({
    userId: resolved.user_id,
    shopDomain: resolved.shop_domain,
    topic,
    eventId,
    payload,
    headers,
  })
  if (!stored) {
    return NextResponse.json({ ok: true, deduped: true })
  }

  await queueWebhookProcessing(resolved.user_id, resolved.shop_domain, topic, eventId)
  void processWebhookEvent({
    userId: resolved.user_id,
    shopDomain: resolved.shop_domain,
    topic,
    eventId,
    payload,
  }).catch((e) => logError("shopify.webhook.background.failed", e, "shopify"))

  log("shopify.webhook.received", { topic, shopDomain }, "shopify")
  return NextResponse.json({ ok: true })
}
