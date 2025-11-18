import { ensureShopifySchema, query } from "./db"
import {
  getShopifyConnectionWithToken,
  listAllShopifyConnectionsWithToken,
  type ShopifyConnectionWithToken,
} from "./shopify-token-store"
import { log } from "./logger"

type ShopifyOrder = { id?: number | string; updated_at?: string; refunds?: Array<{ id?: number | string }> }

export type ShopifySyncResource = "orders" | "refunds"

export type ShopifySyncSummary = {
  shopDomain: string
  resources: {
    resource: ShopifySyncResource
    fetched: number
    upserted: number
    cursorAt: string | null
    error?: string
  }[]
}

function toIsoSafe(value?: string | null): string | null {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

async function getCursorAt(userId: string, shopDomain: string, resource: ShopifySyncResource): Promise<string | null> {
  await ensureShopifySchema()
  const { rows } = await query<{ cursor_at: Date | null }>(
    `SELECT cursor_at
     FROM shopify_sync_state
     WHERE user_id = $1 AND shop_domain = $2 AND resource = $3`,
    [userId, shopDomain, resource]
  )
  const row = rows[0]
  return row?.cursor_at ? row.cursor_at.toISOString() : null
}

async function setCursorAt(userId: string, shopDomain: string, resource: ShopifySyncResource, cursorAt: string | null): Promise<void> {
  await ensureShopifySchema()
  await query(
    `INSERT INTO shopify_sync_state (user_id, shop_domain, resource, cursor_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (user_id, shop_domain, resource) DO UPDATE SET
       cursor_at = EXCLUDED.cursor_at,
       updated_at = NOW()`,
    [userId, shopDomain, resource, cursorAt]
  )
}

async function upsertShopifyEntities(
  userId: string,
  shopDomain: string,
  entityType: ShopifySyncResource,
  entities: Array<Record<string, unknown>>
): Promise<number> {
  if (entities.length === 0) return 0
  await ensureShopifySchema()
  let upserted = 0
  for (const entity of entities) {
    const rawId = entity.id
    if (rawId === undefined || rawId === null) continue
    const entityId = String(rawId)
    await query(
      `INSERT INTO shopify_entities (user_id, shop_domain, entity_type, entity_id, data, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
       ON CONFLICT (shop_domain, entity_type, entity_id) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         data = EXCLUDED.data,
         updated_at = NOW()`,
      [userId, shopDomain, entityType, entityId, JSON.stringify(entity)]
    )
    upserted += 1
  }
  return upserted
}

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null
  const parts = linkHeader.split(",").map((p) => p.trim())
  const next = parts.find((p) => p.includes('rel="next"'))
  if (!next) return null
  const match = next.match(/<([^>]+)>/)
  return match?.[1] ?? null
}

async function fetchOrdersIncremental(
  shopDomain: string,
  accessToken: string,
  cursorAt: string | null
): Promise<{ orders: ShopifyOrder[]; nextCursorAt: string | null }> {
  const apiVersion = process.env.SHOPIFY_API_VERSION ?? "2026-01"
  const base = `https://${shopDomain}/admin/api/${apiVersion}/orders.json`
  const params = new URLSearchParams({
    status: "any",
    limit: "250",
    order: "updated_at asc",
  })
  if (cursorAt) params.set("updated_at_min", cursorAt)

  let nextUrl: string | null = `${base}?${params.toString()}`
  const orders: ShopifyOrder[] = []
  let maxUpdatedAt: string | null = cursorAt
  let pages = 0

  while (nextUrl && pages < 20) {
    pages += 1
    const res = await fetch(nextUrl, {
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new Error(`Shopify orders fetch failed (${res.status}): ${body.slice(0, 300)}`)
    }
    const json = (await res.json()) as { orders?: ShopifyOrder[] }
    const batch = json.orders ?? []
    for (const order of batch) {
      orders.push(order)
      const updatedAt = toIsoSafe(order.updated_at)
      if (updatedAt && (!maxUpdatedAt || updatedAt > maxUpdatedAt)) maxUpdatedAt = updatedAt
    }
    nextUrl = parseNextLink(res.headers.get("link"))
  }

  return { orders, nextCursorAt: maxUpdatedAt }
}

function extractRefunds(orders: ShopifyOrder[]): Array<Record<string, unknown>> {
  const refunds: Array<Record<string, unknown>> = []
  for (const order of orders) {
    const orderId = order.id !== undefined && order.id !== null ? String(order.id) : null
    for (const refund of order.refunds ?? []) {
      if (refund.id === undefined || refund.id === null) continue
      refunds.push({
        ...refund,
        id: refund.id,
        order_id: orderId,
      })
    }
  }
  return refunds
}

export async function runShopifySyncForConnection(
  connection: ShopifyConnectionWithToken
): Promise<ShopifySyncSummary> {
  const { userId, shopDomain, accessToken, missingScopes } = connection
  const summary: ShopifySyncSummary = {
    shopDomain,
    resources: [],
  }

  if (missingScopes.length > 0) {
    return {
      shopDomain,
      resources: [
        {
          resource: "orders",
          fetched: 0,
          upserted: 0,
          cursorAt: null,
          error: `Missing required scopes: ${missingScopes.join(", ")}`,
        },
      ],
    }
  }

  const cursorAt = await getCursorAt(userId, shopDomain, "orders")
  try {
    const { orders, nextCursorAt } = await fetchOrdersIncremental(shopDomain, accessToken, cursorAt)
    const orderRows = orders.map((o) => o as Record<string, unknown>)
    const refunds = extractRefunds(orders)

    const ordersUpserted = await upsertShopifyEntities(userId, shopDomain, "orders", orderRows)
    const refundsUpserted = await upsertShopifyEntities(userId, shopDomain, "refunds", refunds)
    await setCursorAt(userId, shopDomain, "orders", nextCursorAt ?? cursorAt)
    await setCursorAt(userId, shopDomain, "refunds", nextCursorAt ?? cursorAt)

    summary.resources.push({
      resource: "orders",
      fetched: orderRows.length,
      upserted: ordersUpserted,
      cursorAt: nextCursorAt ?? cursorAt,
    })
    summary.resources.push({
      resource: "refunds",
      fetched: refunds.length,
      upserted: refundsUpserted,
      cursorAt: nextCursorAt ?? cursorAt,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    log("shopify.sync.connection.failed", { userId, shopDomain, error: message }, "shopify")
    summary.resources.push({
      resource: "orders",
      fetched: 0,
      upserted: 0,
      cursorAt,
      error: message,
    })
  }

  return summary
}

export async function runShopifySyncForUser(
  userId: string,
  options?: { shopDomain?: string }
): Promise<{ ok: boolean; shops: ShopifySyncSummary[] }> {
  const shops = options?.shopDomain
    ? [await getShopifyConnectionWithToken(userId, options.shopDomain)].filter(Boolean) as ShopifyConnectionWithToken[]
    : (await listAllShopifyConnectionsWithToken()).filter((c) => c.userId === userId)

  if (shops.length === 0) return { ok: false, shops: [] }

  const out: ShopifySyncSummary[] = []
  for (const connection of shops) {
    out.push(await runShopifySyncForConnection(connection))
  }
  return { ok: true, shops: out }
}

export async function runShopifySyncForAllConnections(): Promise<{ total: number; shops: ShopifySyncSummary[] }> {
  const connections = await listAllShopifyConnectionsWithToken()
  const shops: ShopifySyncSummary[] = []
  for (const connection of connections) {
    shops.push(await runShopifySyncForConnection(connection))
  }
  return { total: connections.length, shops }
}
