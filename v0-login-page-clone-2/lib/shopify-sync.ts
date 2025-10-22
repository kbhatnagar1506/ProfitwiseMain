import { ensureShopifySchema, query } from "./db"
import { log, error as logError } from "./logger"
import { enqueueSyncJob, updateWebhookEventStatus } from "./shopify-token-store"

function isProduction(): boolean {
  return process.env.NODE_ENV === "production"
}

export async function registerWebhookSubscriptions(userId: string, shopDomain: string): Promise<void> {
  if (!isProduction()) return
  await ensureShopifySchema()
  const endpointBase = (process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "")
  if (!endpointBase) return
  const endpoint = `${endpointBase}/api/shopify/webhook`
  const topics = [
    "app/uninstalled",
    "orders/paid",
    "orders/updated",
    "refunds/create",
    "shopify_payments/payouts",
  ]
  for (const topic of topics) {
    await query(
      `INSERT INTO shopify_webhook_subscriptions (user_id, shop_domain, topic, endpoint, active, updated_at)
       VALUES ($1, $2, $3, $4, true, NOW())
       ON CONFLICT (user_id, shop_domain, topic, endpoint) DO UPDATE SET active = true, updated_at = NOW()`,
      [userId, shopDomain, topic, endpoint]
    )
  }
}

export async function deactivateWebhookSubscriptions(userId: string, shopDomain: string): Promise<void> {
  if (!isProduction()) return
  await ensureShopifySchema()
  await query(
    "UPDATE shopify_webhook_subscriptions SET active = false, updated_at = NOW() WHERE user_id = $1 AND shop_domain = $2",
    [userId, shopDomain]
  )
}

export async function queueInitialBackfill(userId: string, shopDomain: string): Promise<void> {
  await enqueueSyncJob({
    userId,
    shopDomain,
    jobType: "backfill",
    payload: {
      resources: ["orders", "refunds", "payouts", "balance_transactions"],
      historical_window_days: 365,
      resumable: true,
    },
  })
}

export async function queueWebhookProcessing(userId: string, shopDomain: string, topic: string, eventId: string): Promise<void> {
  await enqueueSyncJob({
    userId,
    shopDomain,
    jobType: "webhook",
    payload: { topic, eventId },
  })
}

export async function processWebhookEvent(input: {
  userId: string
  shopDomain: string
  topic: string
  eventId: string
  payload: Record<string, unknown>
}): Promise<void> {
  try {
    await updateWebhookEventStatus(input.eventId, input.topic, input.shopDomain, "processing")
    if (input.topic === "app/uninstalled") {
      await query(
        `UPDATE shopify_connections
         SET status = 'uninstalled', access_token_encrypted = NULL, updated_at = NOW(), disconnected_at = NOW()
         WHERE user_id = $1 AND shop_domain = $2`,
        [input.userId, input.shopDomain]
      )
      await query(
        `UPDATE shopify_webhook_subscriptions
         SET active = false, updated_at = NOW()
         WHERE user_id = $1 AND shop_domain = $2`,
        [input.userId, input.shopDomain]
      )
    }
    await updateWebhookEventStatus(input.eventId, input.topic, input.shopDomain, "processed")
    log("shopify.webhook.processed", { topic: input.topic, shopDomain: input.shopDomain }, "shopify")
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    await updateWebhookEventStatus(input.eventId, input.topic, input.shopDomain, "failed", message)
    logError("shopify.webhook.process.failed", e, "shopify")
  }
}
